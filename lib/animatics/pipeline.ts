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
 * Parse JSON from an LLM response, tolerating three failure modes:
 *   1. code fences / stray preamble around the JSON,
 *   2. a chatty suffix after the JSON,
 *   3. TRUNCATION — the model hit its output-token limit mid-JSON, leaving
 *      unterminated strings/arrays/objects (the classic
 *      "Expected ',' or ']' after array element" error).
 *
 * For (3) we attempt a structural repair: walk the text tracking string/escape
 * state and bracket depth, drop any dangling partial token, and append the
 * closing quotes/brackets needed to make it valid. This recovers as many
 * complete array elements as the model managed to emit.
 */
function parseLenientJson<T>(raw: string): T {
  const cleaned = stripJson(raw)

  // Fast path.
  try {
    return JSON.parse(cleaned) as T
  } catch {
    /* fall through to repair */
  }

  // Narrow to the JSON object body.
  const first = cleaned.indexOf('{')
  if (first === -1) throw new Error('Model did not return valid JSON.')
  const body = cleaned.slice(first)

  // Try the simple slice-to-last-brace first (handles trailing chatter).
  const lastBrace = body.lastIndexOf('}')
  if (lastBrace > 0) {
    try {
      return JSON.parse(body.slice(0, lastBrace + 1)) as T
    } catch {
      /* fall through to structural repair */
    }
  }

  return repairTruncatedJson(body) as T
}

/**
 * Repair truncated JSON by closing open structures. Walks char-by-char to know
 * whether we're inside a string, then trims any incomplete trailing token and
 * appends the closing brackets in the right order.
 */
function repairTruncatedJson<T>(input: string): T {
  const stack: string[] = [] // '{' or '['
  let inString = false
  let escaped = false
  let lastSafe = -1 // index just after the last completed element/pair

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      lastSafe = i + 1
    } else if (ch === ',') {
      lastSafe = i // cut at a comma → drop the partial element after it
    }
  }

  // If the text ends inside an unterminated string and we have NO earlier safe
  // boundary to fall back to (e.g. a single long "prose" string got cut), close
  // the string so at least that value is recoverable.
  let working = input
  if (inString && lastSafe <= 0) {
    working = input.replace(/\\+$/, '') + '"' // drop a dangling escape, close quote
    lastSafe = working.length
  }

  // Take the text up to the last safe boundary (a completed element/pair).
  let out = lastSafe > 0 ? working.slice(0, lastSafe) : working
  // If we cut at a comma, remove it (can't have a trailing comma).
  out = out.replace(/,\s*$/, '')

  // Recompute the open structures for the trimmed text and close them,
  // accounting for any still-open string.
  const closeStack: string[] = []
  let s = false
  let esc = false
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (s) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') s = false
      continue
    }
    if (ch === '"') s = true
    else if (ch === '{') closeStack.push('}')
    else if (ch === '[') closeStack.push(']')
    else if (ch === '}' || ch === ']') closeStack.pop()
  }
  if (s) out += '"' // close a still-open string
  while (closeStack.length) out += closeStack.pop()

  return JSON.parse(out) as T
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
// Recognizes full-word markers (Episode 3, Chapter VII, Part Two) AND common
// abbreviated forms used in web-serial / screenplay-style novels:
//   "E1: Past Is Prologue", "EP 2 —", "Ch. 4", "#5", "S3:"
// The abbreviated branch accepts an optional trailing separator/title so both
// "E1: Title" and a bare "Ep 3" are caught, but it requires the token to be a
// short prefix (E/EP/CH/S) so ordinary words aren't misread as boundaries.
const BOUNDARY_RE =
  /^\s*(?:(episode|chapter|chapitre|part|act|book|scene)\b[\s.:—-]*(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|(?:ep|e|ch|s)[\s.]*[0-9]{1,3}\b\s*[:.\-—)]?|#\s*[0-9]{1,3}\b)/i

export interface NovelSegment {
  index: number
  label: string
  /**
   * True when `label` is an actual heading taken from the source text (an
   * Episode/Chapter marker). False for synthetic labels the splitter invents
   * ("Part 2", "... (cont. 1)"). Only real headings are echoed into the
   * screenplay output.
   */
  sourceHeading: boolean
  text: string
}

export function segmentNovel(
  novel: string,
  targetChars = 18000,
  maxSegmentChars = 24000,
): NovelSegment[] {
  const lines = novel.split('\n')

  // Pass 1 — cut at explicit episode/chapter/part boundaries.
  const boundaryIdx: number[] = []
  lines.forEach((ln, i) => {
    if (BOUNDARY_RE.test(ln.trim())) boundaryIdx.push(i)
  })

  let rawSegments: { label: string; text: string; sourceHeading: boolean }[] = []

  if (boundaryIdx.length >= 2) {
    // Many novels repeat their markers in a table of contents at the top (each
    // TOC line is a boundary but has no prose after it). Drop boundaries whose
    // content is too short to be a real chapter — that filters out the TOC and
    // keeps only the actual body starts. A real episode is well over 400 chars.
    const MIN_SEGMENT_CHARS = 400
    const filtered: number[] = []
    for (let k = 0; k < boundaryIdx.length; k++) {
      const from = boundaryIdx[k]
      const to = k + 1 < boundaryIdx.length ? boundaryIdx[k + 1] : lines.length
      const between = lines.slice(from + 1, to).join('\n').trim()
      if (between.length >= MIN_SEGMENT_CHARS) filtered.push(from)
    }
    const effective = filtered.length >= 2 ? filtered : boundaryIdx

    // Include any preamble before the first boundary with the first segment.
    const starts = effective[0] === 0 ? effective : [0, ...effective]
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s]
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length
      const chunk = lines.slice(from, to).join('\n').trim()
      if (!chunk) continue
      // Skip a leading preamble chunk that is itself just front-matter/TOC.
      if (s === 0 && from === 0 && chunk.length < MIN_SEGMENT_CHARS) continue
      // A segment that starts ON a boundary line carries a real source heading;
      // a prepended preamble chunk (from === 0, not itself a boundary) does not.
      const startedOnBoundary = BOUNDARY_RE.test((lines[from] || '').trim())
      const label = startedOnBoundary
        ? (lines[from] || '').trim().slice(0, 80)
        : `Segment ${s + 1}`
      rawSegments.push({ label, text: chunk, sourceHeading: startedOnBoundary })
    }
  } else {
    // Pass 2 — no usable markers: pack paragraphs to ~targetChars.
    const paras = novel.split(/\n\s*\n/)
    let buf = ''
    let n = 1
    for (const p of paras) {
      if (buf && buf.length + p.length > targetChars) {
        rawSegments.push({ label: `Part ${n++}`, text: buf.trim(), sourceHeading: false })
        buf = ''
      }
      buf += (buf ? '\n\n' : '') + p
    }
    if (buf.trim()) rawSegments.push({ label: `Part ${n}`, text: buf.trim(), sourceHeading: false })
  }

  // Pass 3 — hard-split any oversized segment so no single call is too large.
  const bounded: { label: string; text: string; sourceHeading: boolean }[] = []
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
      // Only the FIRST piece of a split episode keeps the source heading, so
      // the episode title is printed once, not on every continuation.
      bounded.push({
        label: part === 1 ? seg.label : `${seg.label} (cont. ${part})`,
        text: rest.slice(0, cut).trim(),
        sourceHeading: part === 1 ? seg.sourceHeading : false,
      })
      part++
      rest = rest.slice(cut)
    }
    if (rest.trim())
      bounded.push({
        label: `${seg.label} (cont. ${part})`,
        text: rest.trim(),
        sourceHeading: false,
      })
  }

  return bounded.map((s, i) => ({
    index: i,
    label: s.label,
    sourceHeading: s.sourceHeading,
    text: s.text,
  }))
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
- FIDELITY: adapt the source faithfully and completely. Preserve every plot beat, reveal, and scene in the given part. Preserve the dialogue — keep the characters' spoken lines (you may lightly tighten them, but do not cut exchanges or invent plot). Do not summarize multiple events into one line; give each its own shot.
- Generate as many shots as the material needs to cover the whole part — do not compress to hit a small number. A typical episode yields many shots.
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
): Promise<{ prose: string; shots: Shot[]; label: string; sourceHeading: boolean }> {
  const provider = await boundProvider(email)
  const context =
    totalSegments > 1
      ? `This is part ${segment.index + 1} of ${totalSegments} ("${segment.label}") of a longer novel. Adapt THIS part fully into screenplay form — every scene in this part must appear; do not summarize or skip. Continue the same ongoing story.\n\n`
      : ''

  const raw = await provider.chatText({
    system: SCREENPLAY_SYSTEM,
    user: `CAST (use these exact names):\n${castLinesFor(characters)}\n\n${context}NOVEL PART:\n\n${segment.text}`,
    // Generous ceiling: a single episode's prose + shots can be large. Combined
    // with per-segment generation and JSON-repair, this keeps responses whole.
    maxTokens: 16000,
  })

  let parsed: { prose?: string; shots?: unknown }
  try {
    parsed = parseLenientJson<{ prose?: string; shots?: unknown }>(raw)
  } catch {
    // Even repair failed (rare). Return empty so the route notes the section as
    // skipped and continues rather than failing the whole run.
    return { prose: '', shots: [], label: segment.label, sourceHeading: segment.sourceHeading }
  }
  const prose = String(parsed.prose || '').trim()
  const shots = normalizeShots(parsed.shots, sceneOffset, shotOffset)
  return { prose, shots, label: segment.label, sourceHeading: segment.sourceHeading }
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
      const { prose, shots, label, sourceHeading } = await generateSegment(
        email,
        characters,
        seg,
        segments.length,
        sceneOffset,
        allShots.length,
      )
      if (prose) {
        if (sourceHeading) proseParts.push(`\n\n## ${label}\n`)
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
