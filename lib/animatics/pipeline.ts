import { makeProvider, stripJson } from '@/lib/rag/provider'
import { getLlmConfig } from '@/lib/rag/llm-keys'
import crypto from 'crypto'
import type { Character, Shot } from './store'

/**
 * The two LLM stages of Animatics Phase 1, built on the app's existing
 * provider layer (user's own key from Settings). Stage 1 extracts the cast;
 * Stage 2 turns the novel + cast into a detailed screenplay AND a structured
 * shot list in a single pass, so Phase 2 has its data contract ready.
 */

export class NoLlmKeyError extends Error {
  constructor() {
    super('No LLM key configured. Add one under Settings before running Animatics.')
    this.name = 'NoLlmKeyError'
  }
}

async function boundProvider(email: string) {
  const cfg = await getLlmConfig(email)
  if (!cfg) throw new NoLlmKeyError()
  return makeProvider(cfg)
}

/**
 * Parse JSON from an LLM response even when the model wraps it in code fences
 * or adds a stray preamble/suffix. Falls back to slicing from the first '{' to
 * the last '}' so a chatty model doesn't break the pipeline.
 */
function parseLenientJson<T>(raw: string): T {
  const cleaned = stripJson(raw)
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first !== -1 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1)) as T
    }
    throw new Error('Model did not return valid JSON.')
  }
}

/** Truncate very long novels so a single request stays within context limits. */
function clampNovel(novel: string, maxChars = 45000): string {
  if (novel.length <= maxChars) return novel
  // Keep the opening (establishes cast) and the ending (resolution).
  const head = novel.slice(0, Math.floor(maxChars * 0.7))
  const tail = novel.slice(-Math.floor(maxChars * 0.3))
  return `${head}\n\n[...middle omitted for length...]\n\n${tail}`
}

// ---------------------------------------------------------------------------
// Stage 1 — character extraction
// ---------------------------------------------------------------------------

const CHARACTER_SYSTEM = `You are a script supervisor. You read a novel and identify the NAMED characters who appear, speak, or act in the story. You return ONLY strict JSON — no prose, no markdown, no code fences.

Rules:
- Include only characters that matter to the story (protagonists, antagonists, meaningful supporting roles). Skip crowds, unnamed passersby, and one-off mentions.
- For each character infer a concise physical description from the text (build, hair, age range, distinctive features). If the novel gives none, infer something plausible from context and mark it as inferred by prefixing with "(inferred)".
- role is one of: "protagonist", "antagonist", "supporting", "minor".
- Return at most 12 characters.

Output shape:
{"characters":[{"name":"...","description":"...","role":"protagonist"}]}`

interface RawCharacter {
  name: string
  description: string
  role: string
}

export async function extractCharacters(email: string, novel: string): Promise<Character[]> {
  const provider = await boundProvider(email)
  const raw = await provider.chatText({
    system: CHARACTER_SYSTEM,
    user: `Novel:\n\n${clampNovel(novel)}`,
    maxTokens: 2000,
  })

  let parsed: { characters?: RawCharacter[] }
  try {
    parsed = parseLenientJson<{ characters?: RawCharacter[] }>(raw)
  } catch {
    throw new Error('Character extraction did not return valid JSON. Try again.')
  }
  const list = Array.isArray(parsed.characters) ? parsed.characters : []

  return list.slice(0, 12).map((c) => ({
    id: crypto.randomUUID(),
    name: String(c.name || 'Unnamed').slice(0, 80),
    description: String(c.description || '').slice(0, 500),
    role: ['protagonist', 'antagonist', 'supporting', 'minor'].includes(c.role)
      ? c.role
      : 'supporting',
    hasHeadshot: false,
    headshotMime: null,
  }))
}

// ---------------------------------------------------------------------------
// Stage 2 — screenplay + shot list
// ---------------------------------------------------------------------------

const SCREENPLAY_SYSTEM = `You are a professional screenwriter and storyboard artist adapting a novel into a richly detailed animatics screenplay.

You will be given the novel and its cast (with the exact character names to use). Produce a screenplay with UTMOST vivid visual detail: for every scene describe the background and foreground, lighting and mood, and for every character on screen describe their clothing colors, pose, and facial expression. Beautify and enrich the imagery to fit the theme of the story.

You MUST return ONLY strict JSON with two top-level keys — no prose outside the JSON, no markdown, no code fences:

{
  "prose": "The full human-readable screenplay as a single string. Use SCENE headings (e.g. 'SCENE 1 — INT. TRAIN CAR — DUSK'), vivid action/description paragraphs, and dialogue lines formatted as 'NAME: line'. This is what the human reads and edits.",
  "shots": [
    {
      "scene": 1,
      "shot": 1,
      "background": "vivid description of the setting/backdrop",
      "characters": [
        {"name":"EXACT cast name","clothingColor":"...","pose":"...","expression":"..."}
      ],
      "dialogue": [{"speaker":"EXACT cast name","line":"..."}],
      "cameraFraming": "e.g. wide establishing / medium two-shot / close-up",
      "ambientSound": "diegetic background sound only, e.g. 'rain on glass, distant train rumble' — no music"
    }
  ]
}

Rules:
- Use ONLY the provided cast names for named characters. Extra background figures are allowed in descriptions but never in the "characters" name field.
- Keep prose and shots consistent: every shot must correspond to a moment in the prose.
- Aim for 8–40 shots depending on story length.
- Every character entry needs a concrete clothingColor, pose, and expression.`

export interface ScreenplayResult {
  prose: string
  shots: Shot[]
}

export async function generateScreenplay(
  email: string,
  novel: string,
  characters: Character[],
): Promise<ScreenplayResult> {
  const provider = await boundProvider(email)
  const castLines = characters
    .map((c) => `- ${c.name} (${c.role}): ${c.description}`)
    .join('\n')

  const raw = await provider.chatText({
    system: SCREENPLAY_SYSTEM,
    user: `CAST (use these exact names):\n${castLines}\n\nNOVEL:\n\n${clampNovel(novel)}`,
    maxTokens: 8000,
  })

  let parsed: { prose?: string; shots?: unknown }
  try {
    parsed = parseLenientJson<{ prose?: string; shots?: unknown }>(raw)
  } catch {
    throw new Error('Screenplay generation did not return valid JSON. Try again.')
  }

  const prose = String(parsed.prose || '').trim()
  if (!prose) throw new Error('Screenplay generation returned empty prose.')

  const shots: Shot[] = Array.isArray(parsed.shots)
    ? (parsed.shots as Record<string, unknown>[]).map((s, i) => ({
        scene: Number(s.scene) || 1,
        shot: Number(s.shot) || i + 1,
        background: String(s.background || ''),
        characters: Array.isArray(s.characters)
          ? (s.characters as Record<string, unknown>[]).map((ch) => ({
              name: String(ch.name || ''),
              clothingColor: String(ch.clothingColor || ''),
              pose: String(ch.pose || ''),
              expression: String(ch.expression || ''),
            }))
          : [],
        dialogue: Array.isArray(s.dialogue)
          ? (s.dialogue as Record<string, unknown>[]).map((d) => ({
              speaker: String(d.speaker || ''),
              line: String(d.line || ''),
            }))
          : [],
        cameraFraming: String(s.cameraFraming || ''),
        ambientSound: String(s.ambientSound || ''),
      }))
    : []

  return { prose, shots }
}

/**
 * Re-parse an edited screenplay back into a refreshed shot list so Phase 2
 * stays in sync with the human's edits. Called on approval when the prose has
 * changed from what was generated.
 */
export async function reparseEditedScreenplay(
  email: string,
  editedProse: string,
  characters: Character[],
): Promise<Shot[]> {
  const provider = await boundProvider(email)
  const castNames = characters.map((c) => c.name).join(', ')

  const raw = await provider.chatText({
    system: `You convert an already-written screenplay into a structured shot list. Return ONLY strict JSON: {"shots":[...]} using the same shot shape (scene, shot, background, characters[{name,clothingColor,pose,expression}], dialogue[{speaker,line}], cameraFraming, ambientSound). Use only these character names for the "name"/"speaker" fields: ${castNames}.`,
    user: `SCREENPLAY:\n\n${editedProse.slice(0, 45000)}`,
    maxTokens: 8000,
  })

  let parsed: { shots?: unknown }
  try {
    parsed = parseLenientJson<{ shots?: unknown }>(raw)
  } catch {
    return [] // non-fatal: keep the prior shot list if re-parse fails
  }
  if (!Array.isArray(parsed.shots)) return []
  return (parsed.shots as Record<string, unknown>[]).map((s, i) => ({
    scene: Number(s.scene) || 1,
    shot: Number(s.shot) || i + 1,
    background: String(s.background || ''),
    characters: Array.isArray(s.characters)
      ? (s.characters as Record<string, unknown>[]).map((ch) => ({
          name: String(ch.name || ''),
          clothingColor: String(ch.clothingColor || ''),
          pose: String(ch.pose || ''),
          expression: String(ch.expression || ''),
        }))
      : [],
    dialogue: Array.isArray(s.dialogue)
      ? (s.dialogue as Record<string, unknown>[]).map((d) => ({
          speaker: String(d.speaker || ''),
          line: String(d.line || ''),
        }))
      : [],
    cameraFraming: String(s.cameraFraming || ''),
    ambientSound: String(s.ambientSound || ''),
  }))
}
