import crypto from 'crypto'

/**
 * Per-user LLM credentials in Upstash Redis (same store as Gmail tokens),
 * encrypted with AES-256-GCM under ENTWIN_KEY_SECRET (shared with the worker).
 * The API key is never persisted in plaintext and never sent back to the client
 * after saving.
 */

export type LlmProvider = 'claude' | 'openai' | 'gemini'

export interface LlmConfig {
  provider: LlmProvider
  model: string
  apiKey: string
}

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN

function encKey(): Buffer {
  const s = process.env.ENTWIN_KEY_SECRET
  if (!s) throw new Error('ENTWIN_KEY_SECRET is not set')
  return crypto.createHash('sha256').update(s).digest()
}

function redisKey(userEmail: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`llm::${userEmail}`.toLowerCase())
    .digest('hex')
    .slice(0, 24)
  return `entwin:llm:${hash}`
}

async function redisCmd(args: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`Redis ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(`Redis error: ${json.error}`)
  return json.result
}

function encrypt(config: LlmConfig): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.')
}

function decrypt(blob: string): LlmConfig {
  const [ivB64, tagB64, dataB64] = blob.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const out = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(out.toString('utf8')) as LlmConfig
}

const TTL_SECONDS = 365 * 24 * 60 * 60

export async function saveLlmConfig(userEmail: string, config: LlmConfig): Promise<void> {
  await redisCmd(['SET', redisKey(userEmail), encrypt(config), 'EX', TTL_SECONDS])
}

export async function getLlmConfig(userEmail: string): Promise<LlmConfig | null> {
  const raw = (await redisCmd(['GET', redisKey(userEmail)])) as string | null
  if (!raw) return null
  return decrypt(raw)
}

/** Whether a key is set — safe to return to the client (no secret leaks). */
export async function hasLlmConfig(
  userEmail: string,
): Promise<{ configured: boolean; provider?: LlmProvider; model?: string }> {
  const cfg = await getLlmConfig(userEmail)
  if (!cfg) return { configured: false }
  return { configured: true, provider: cfg.provider, model: cfg.model }
}
