import crypto from 'crypto'

/**
 * Job state for the Animatics Phase-1 pipeline, stored in the same Upstash Redis
 * the rest of the app uses (LLM keys, Gmail tokens). One job per pipeline run.
 *
 * "Simplest to run" storage choice: Redis is already wired and needs no schema
 * migration. The generated .docx is stored base64 in the job blob (Phase-1
 * documents are small — tens of KB), so there is no separate object store to
 * provision. Headshots are likewise held base64 on each character.
 */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN

async function redisCmd(args: (string | number)[]): Promise<unknown> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error(
      'Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (same store used for LLM keys).',
    )
  }
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`Redis ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(`Redis error: ${json.error}`)
  return json.result
}

export type JobStatus =
  | 'EXTRACTING' //         novel stored, character extraction pending/in-flight
  | 'PARSED' //             novel cleaned, characters extracted, awaiting headshots
  | 'AWAITING_HEADSHOTS' // some characters still missing a headshot
  | 'GENERATING' //         screenplay LLM call in flight
  | 'AWAITING_APPROVAL' //  docx ready, user reviewing/editing
  | 'APPROVED' //           final screenplay approved — ready for Phase 2
  | 'ERROR'

export interface Character {
  id: string
  name: string
  description: string // physical description from the LLM
  role: string //        e.g. protagonist, antagonist, supporting
  /**
   * Whether a headshot has been uploaded. The image bytes are stored under a
   * SEPARATE Redis key (see headshot helpers below) so the job blob stays
   * small — base64 images inside the job would blow past request/value size
   * limits once there are several characters.
   */
  hasHeadshot: boolean
  headshotMime: string | null
}

/** One shot in the structured shot-list — the real Phase-2 contract. */
export interface Shot {
  scene: number
  shot: number
  background: string
  characters: {
    name: string
    clothingColor: string
    pose: string
    expression: string
  }[]
  dialogue: { speaker: string; line: string }[]
  cameraFraming: string
  ambientSound: string
}

export interface Job {
  id: string
  owner: string // user email
  status: JobStatus
  createdAt: number
  updatedAt: number
  novel: string // cleaned novel text
  parseStats: Record<string, number>
  characters: Character[]
  /** Human-readable screenplay prose (the .docx body), once generated. */
  screenplayProse: string | null
  /** Structured shot list — dormant until Phase 2. */
  shotList: Shot[] | null
  /** base64 .docx, regenerated whenever prose changes. */
  docxBase64: string | null
  /**
   * Screenplay generation progress. Long/multi-episode novels are generated
   * segment-by-segment across multiple short requests so no single call times
   * out. null until generation starts.
   */
  progress: {
    totalSegments: number
    doneSegments: number
    proseParts: string[]
    shots: Shot[]
    sceneOffset: number
  } | null
  error: string | null
}

function jobKey(id: string): string {
  return `entwin:animatics:job:${id}`
}
function ownerIndexKey(email: string): string {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)
  return `entwin:animatics:owner:${hash}`
}
function headshotKey(jobId: string, characterId: string): string {
  return `entwin:animatics:headshot:${jobId}:${characterId}`
}

const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export async function createJob(
  owner: string,
  novel: string,
  parseStats: Record<string, number>,
  characters: Character[],
): Promise<Job> {
  const now = Date.now()
  const job: Job = {
    id: crypto.randomUUID(),
    owner,
    // No characters yet → EXTRACTING (a separate, retryable step does the LLM
    // extraction so the upload request returns instantly and never times out).
    status: characters.length ? 'AWAITING_HEADSHOTS' : 'EXTRACTING',
    createdAt: now,
    updatedAt: now,
    novel,
    parseStats,
    characters,
    screenplayProse: null,
    shotList: null,
    docxBase64: null,
    progress: null,
    error: null,
  }
  await redisCmd(['SET', jobKey(job.id), JSON.stringify(job), 'EX', TTL_SECONDS])
  // Track the latest job per owner so the UI can resume after reload.
  await redisCmd(['SET', ownerIndexKey(owner), job.id, 'EX', TTL_SECONDS])
  return job
}

export async function getJob(id: string): Promise<Job | null> {
  const raw = (await redisCmd(['GET', jobKey(id)])) as string | null
  if (!raw) return null
  return JSON.parse(raw) as Job
}

export async function getLatestJobId(owner: string): Promise<string | null> {
  return (await redisCmd(['GET', ownerIndexKey(owner)])) as string | null
}

export async function saveJob(job: Job): Promise<void> {
  job.updatedAt = Date.now()
  await redisCmd(['SET', jobKey(job.id), JSON.stringify(job), 'EX', TTL_SECONDS])
}

/**
 * Load a job and assert the caller owns it. Central guard against one user
 * touching another user's pipeline via a guessed job id.
 */
export async function getOwnedJob(id: string, owner: string): Promise<Job | null> {
  const job = await getJob(id)
  if (!job || job.owner.toLowerCase() !== owner.toLowerCase()) return null
  return job
}

// --- headshots stored as separate keys (kept out of the job blob) ----------

/**
 * Store one character's headshot as its own Redis key. Keeping images out of
 * the job blob is what makes multi-character uploads work: each write is small
 * and no single Redis value grows unbounded.
 */
export async function saveHeadshot(
  jobId: string,
  characterId: string,
  dataUrl: string,
): Promise<void> {
  await redisCmd(['SET', headshotKey(jobId, characterId), dataUrl, 'EX', TTL_SECONDS])
}

export async function getHeadshot(
  jobId: string,
  characterId: string,
): Promise<string | null> {
  return (await redisCmd(['GET', headshotKey(jobId, characterId)])) as string | null
}

/**
 * Delete a job and everything associated with it — the job blob, every
 * character's headshot key, and the owner→latest-job index. Used by Disconnect
 * so the user can start a completely fresh run from scratch. Ownership is
 * checked by the caller (route) via getOwnedJob before calling this.
 */
export async function deleteJob(job: Job): Promise<void> {
  // Remove each stored headshot.
  for (const c of job.characters) {
    await redisCmd(['DEL', headshotKey(job.id, c.id)])
  }
  // Remove the job blob.
  await redisCmd(['DEL', jobKey(job.id)])
  // Clear the owner index if it still points at this job.
  const latest = (await redisCmd(['GET', ownerIndexKey(job.owner)])) as string | null
  if (latest === job.id) {
    await redisCmd(['DEL', ownerIndexKey(job.owner)])
  }
}
