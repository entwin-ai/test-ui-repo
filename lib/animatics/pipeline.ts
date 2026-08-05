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

/**
 * For CHARACTER EXTRACTION only, a modest sample is enough to find the cast
 * without reading every word — the opening of a novel introduces essentially
 * all the main characters. Kept small so the extraction LLM call returns
 * quickly and never trips the function timeout. Screenplay generation does NOT
 * use this; it reads the whole novel via segmentation.
 */
function sampleForCast(novel: string, maxChars = 24000): string {
  if (novel.length <= maxChars) return novel
  // Opening establishes most of the cast; a small tail catches late arrivals.
  const head = novel.slice(0, Math.floor(maxChars * 0.8))
  const tail = novel.slice(-Math.floor(maxChars * 0.2))
  return `${head}\n\n[...middle omitted for cast sampling...]\n\n${tail}`
}

/**
 * Split a long novel into ordered segments so the WHOLE story is adapted, not
 * just the opening. This is the fix for multi-episode novels: previously the
 * novel was truncated to ~45k chars (roughly one episode) before generation.
 *
 * Strategy:
 *  1. Prefer natural boundaries — lines like "Episode 3", "Chapter VII",
 *     "Part Two", "Act 2". Each becomes the start of a segment.
 *  2. If there are too few/no such markers, fall back to packing paragraphs
 *     into ~targetChars-sized segments on blank-line boundaries.
 *  3. If a single segment is still larger than maxSegmentChars, hard-split it.
 */
const BOUNDARY_RE =
  /^\s*(episode|chapter|chapitre|part|act|book|scene)\b[\s.:—-]*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

export interface NovelSegment {
  index: number
  label: string
  text: string
}

export function segmentNovel(
  novel: string,
  targetChars = 30000,
  maxSegmentChars = 40000,
): NovelSegment[] {
  const lines = novel.split('\n')

  // Pass 1 — cut at explicit episode/chapter/part boundaries.
  const boundaryIdx: number[] = []
  lines.forEach((ln, i) => {
    if (BOUNDARY_RE.test(ln.trim())) boundaryIdx.push(i)
  })

  let rawSegments: { label: string; text: string }[] = []

  if (boundaryIdx.length >= 2) {
    // Include any preamble before the first boundary with the first segment.
    const starts = boundaryIdx[0] === 0 ? boundaryIdx : [0, ...boundaryIdx]
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s]
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length
      const chunk = lines.slice(from, to).join('\n').trim()
      if (!chunk) continue
      const label = (lines[from] || '').trim().slice(0, 60) || `Segment ${s + 1}`
      rawSegments.push({ label, text: chunk })
    }
  } else {
    // Pass 2 — no usable markers: pack paragraphs to ~targetChars.
    const paras = novel.split(/\n\s*\n/)
    let buf = ''
    let n = 1
    for (const p of paras) {
      if (buf && buf.length + p.length > targetChars) {
        rawSegments.push({ label: `Part ${n++}`, text: buf.trim() })
        buf = ''
      }
      buf += (buf ? '\n\n' : '') + p
    }
    if (buf.trim()) rawSegments.push({ label: `Part ${n}`, text: buf.trim() })
  }

  // Pass 3 — hard-split any oversized segment so no single call is too large.
  const bounded: { label: string; text: string }[] = []
  for (const seg of rawSegments) {
    if (seg.text.length <= maxSegmentChars) {
      bounded.push(seg)
      continue
    }
    let rest = seg.text
    let part = 1
    while (rest.length > maxSegmentChars) {
      // Split on the last paragraph break before the cap to avoid cutting mid-scene.
      let cut = rest.lastIndexOf('\n\n', maxSegmentChars)
      if (cut < maxSegmentChars * 0.5) cut = maxSegmentChars // no good break — hard cut
      bounded.push({ label: `${seg.label} (cont. ${part++})`, text: rest.slice(0, cut).trim() })
      rest = rest.slice(cut)
    }
    if (rest.trim()) bounded.push({ label: `${seg.label} (cont. ${part})`, text: rest.trim() })
  }

  return bounded.map((s, i) => ({ index: i, label: s.label, text: s.text }))
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
    user: `Novel:\n\n${sampleForCast(novel)}`,
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
  segments: number
}

/** Normalize a raw shots array from the model into typed Shot[]. */
function normalizeShots(rawShots: unknown, sceneOffset: number, shotOffset: number): Shot[] {
  if (!Array.isArray(rawShots)) return []
  return (rawShots as Record<string, unknown>[]).map((s, i) => ({
    scene: (Number(s.scene) || 1) + sceneOffset,
    shot: (Number(s.shot) || i + 1) + shotOffset,
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

function castLinesFor(characters: Character[]): string {
  return characters.map((c) => `- ${c.name} (${c.role}): ${c.description}`).join('\n')
}

/**
 * Generate the screenplay for ONE segment. Returns the segment's prose and its
 * normalized shots (scene/shot numbers offset so parts don't restart at 1).
 *
 * This is called incrementally by the screenplay route — one (or a few)
 * segments per HTTP request — so a long, multi-episode novel is adapted across
 * several short calls instead of one request that would time out. Each call's
 * result is persisted to the job, making generation resumable.
 */
export async function generateSegment(
  email: string,
  characters: Character[],
  segment: NovelSegment,
  totalSegments: number,
  sceneOffset: number,
  shotOffset: number,
): Promise<{ prose: string; shots: Shot[]; label: string }> {
  const provider = await boundProvider(email)
  const context =
    totalSegments > 1
      ? `This is part ${segment.index + 1} of ${totalSegments} ("${segment.label}") of a longer novel. Adapt THIS part fully into screenplay form — every scene in this part must appear; do not summarize or skip. Continue the same ongoing story.\n\n`
      : ''

  const raw = await provider.chatText({
    system: SCREENPLAY_SYSTEM,
    user: `CAST (use these exact names):\n${castLinesFor(characters)}\n\n${context}NOVEL PART:\n\n${segment.text}`,
    maxTokens: 8000,
  })

  const parsed = parseLenientJson<{ prose?: string; shots?: unknown }>(raw)
  const prose = String(parsed.prose || '').trim()
  const shots = normalizeShots(parsed.shots, sceneOffset, shotOffset)
  return { prose, shots, label: segment.label }
}

/**
 * Non-incremental convenience generator (used only for short novels / tests).
 * Processes every segment in one call. For long novels the route uses the
 * incremental path above instead.
 */
export async function generateScreenplay(
  email: string,
  novel: string,
  characters: Character[],
): Promise<ScreenplayResult> {
  const segments = segmentNovel(novel)
  const proseParts: string[] = []
  const allShots: Shot[] = []
  let sceneOffset = 0

  for (const seg of segments) {
    try {
      const { prose, shots, label } = await generateSegment(
        email,
        characters,
        seg,
        segments.length,
        sceneOffset,
        allShots.length,
      )
      if (prose) {
        if (segments.length > 1) proseParts.push(`\n\n=== ${label} ===\n`)
        proseParts.push(prose)
      }
      allShots.push(...shots)
      sceneOffset = shots.reduce((m, s) => Math.max(m, s.scene), sceneOffset)
    } catch {
      proseParts.push(`\n\n[Part "${seg.label}" could not be generated and was skipped.]\n`)
    }
  }

  const prose = proseParts.join('\n').trim()
  if (!prose) throw new Error('Screenplay generation returned empty prose.')
  return { prose, shots: allShots, segments: segments.length }
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
