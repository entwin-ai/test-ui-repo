'use client'

/*
 * Entwin frontend — screens ported from entwin_frontend_v3.html.
 * Navigation is reproduced exactly. Google authentication is the only wired
 * behavior (real NextAuth Google OAuth). Every other screen is static /
 * local-only, matching the reference HTML prototype.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession, signIn, signOut } from 'next-auth/react'
import { LOGO_DATA_URI } from './logo'
import AnimaticsFlow from './animatics-flow'

type ViewKey = 'chat' | 'allchats' | 'connectors' | 'dashboard' | 'memory' | 'settings'
type DashTab = 'overview' | 'kanban' | 'wa-kanban' | 'entities'
type ListKey = 'marketing' | 'updates' | 'people'
type ProviderKey = 'claude' | 'gemini' | 'openai' | 'neocloud' | 'onprem'

/* ---------------- Static data (from v3 HTML) ---------------- */

const BRAND_ICONS: Record<string, JSX.Element> = {
  gmail: (
    <svg viewBox="0 0 48 48">
      <path fill="#4caf50" d="M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
      <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
      <path fill="#e53935" d="M35,11.2l-11,8.25l-11-8.25L12,17l11,8.25L34,17L35,11.2z" />
      <path fill="#c62828" d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8H7C4.791,8,3,9.791,3,12.298z" />
      <path fill="#fbc02d" d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8H41C43.209,8,45,9.791,45,12.298z" />
    </svg>
  ),
  drive: (
    <svg viewBox="0 0 87.3 78">
      <path fill="#0066da" d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="M43.65 25L29.9 1.2C28.55 2 27.4 3.1 26.6 4.5L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" />
      <path fill="#ea4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57.5c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.65z" />
      <path fill="#00832d" d="M43.65 25L57.4 1.2C56.05 0.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.5c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="M73.4 26.5L60.1 3.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24">
      <rect x="2" y="4" width="20" height="18" rx="2" fill="#fff" stroke="#dadce0" strokeWidth="1" />
      <rect x="2.5" y="4.5" width="19" height="5" fill="#1a73e8" />
      <text x="12" y="17.5" fontSize="9.5" fontWeight="700" fill="#1a73e8" textAnchor="middle" fontFamily="Arial, sans-serif">31</text>
    </svg>
  ),
  slack: (
    <svg viewBox="0 0 24 24">
      <path fill="#36c5f0" d="M9 3.5A1.75 1.75 0 1 0 7.25 5.25H9V3.5z" transform="translate(0 0)" />
      <path fill="#36c5f0" d="M5.25 8.75A1.75 1.75 0 0 1 3.5 7 1.75 1.75 0 0 1 5.25 5.25h4.5A1.75 1.75 0 0 1 11.5 7v1.75H5.25z" />
      <path fill="#2eb67d" d="M20.5 9a1.75 1.75 0 1 0-1.75 1.75H20.5V9z" />
      <path fill="#2eb67d" d="M15.25 5.25A1.75 1.75 0 0 1 17 3.5a1.75 1.75 0 0 1 1.75 1.75v4.5A1.75 1.75 0 0 1 17 11.5h-1.75v-6.25z" />
      <path fill="#ecb22e" d="M15 20.5a1.75 1.75 0 1 0 1.75-1.75H15V20.5z" />
      <path fill="#ecb22e" d="M18.75 15.25A1.75 1.75 0 0 1 20.5 17a1.75 1.75 0 0 1-1.75 1.75h-4.5A1.75 1.75 0 0 1 12.5 17v-1.75h6.25z" />
      <path fill="#e01e5a" d="M3.5 15a1.75 1.75 0 1 0 1.75 1.75V15H3.5z" />
      <path fill="#e01e5a" d="M8.75 18.75A1.75 1.75 0 0 1 7 20.5a1.75 1.75 0 0 1-1.75-1.75v-4.5A1.75 1.75 0 0 1 7 12.5h1.75v6.25z" />
    </svg>
  ),
  animatics: (
    <svg viewBox="0 0 48 48">
      <defs>
        <linearGradient id="animaticsTile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1FB184" />
          <stop offset="55%" stopColor="#0F6E56" />
          <stop offset="100%" stopColor="#084438" />
        </linearGradient>
        <linearGradient id="animaticsFilm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#E1F5EE" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="48" height="48" rx="11" fill="url(#animaticsTile)" />
      <rect x="0" y="0" width="48" height="24" rx="11" fill="#ffffff" opacity="0.06" />
      <g transform="translate(24,25.5)">
        <path d="M0,-15.5 L9.2,13.4 L2.9,13.4 L0,5.5 L-2.9,13.4 L-9.2,13.4 Z" fill="url(#animaticsFilm)" />
        <rect x="-1.9" y="7.1" width="3.8" height="2.6" rx="0.7" fill="url(#animaticsFilm)" />
        <circle cx="-6.4" cy="11.2" r="0.9" fill="#0F6E56" />
        <circle cx="-4.1" cy="4.1" r="0.9" fill="#0F6E56" />
        <circle cx="6.4" cy="11.2" r="0.9" fill="#0F6E56" />
        <circle cx="4.1" cy="4.1" r="0.9" fill="#0F6E56" />
        <g transform="translate(0,-2.6)">
          <path d="M-4.7,-1 h9.4 a2.1,2.1 0 0 1 2.1,2.1 v2.9 a2.1,2.1 0 0 1 -2.1,2.1 h-6.3 l-2.6,2.3 v-2.3 h-0.5 a2.1,2.1 0 0 1 -2.1,-2.1 v-2.9 a2.1,2.1 0 0 1 2.1,-2.1 Z" fill="#FAC775" />
          <path d="M-0.9,0.7 L3,3 L-0.9,5.3 Z" fill="#084438" />
        </g>
      </g>
    </svg>
  ),
  babelscribe: (
    <img src="/babelscribe.png" alt="Babelscribe" width={48} height={48} style={{ display: 'block', borderRadius: 11 }} />
  ),
  chorale: (
    <img src="/chorale-icon.png" alt="Chorale" width={48} height={48} style={{ display: 'block', borderRadius: 11 }} />
  ),
}

interface GmailScan {
  inboxCount: number
  sentCount: number
}

interface WaStatus {
  state: 'disconnected' | 'pairing' | 'connected'
  linked?: boolean
  totalMessages?: number
  processedMessages?: number
  chats?: number
  earliest?: string | null
  latest?: string | null
}

interface SlackChannelCount {
  id: string
  name: string
  type: 'public' | 'private' | 'im' | 'mpim'
  messageCount: number
}

interface SlackScan {
  totalMessages: number
  activeChannels: number
  scannedChannels: number
  channels: SlackChannelCount[]
  windowDays: number
}

// Per-connector settings persisted per user (mirrors lib/connectors/state.ts).
interface ConnectorSettings {
  pollHours: number
  backfillDays: number
  totalWindowDays: number
}
const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  pollHours: 24,
  backfillDays: 30,
  totalWindowDays: 365,
}

interface Connector {
  name: string
  service: string | null
  icon?: string
  code?: string
  desc: string
  connected: boolean
  connectedEmail: string | null
  // Stable per-card slug used to persist connect state + settings per user
  // (see CONNECTOR_KEYS in lib/connectors/state.ts). Every card has one.
  key: string
  // Per-user settings for this card, loaded on mount and saved from the modal.
  settings?: ConnectorSettings
  // Last on-demand/poll read of this card (ISO), or null if never. Backs the
  // "Last read" line in the settings modal.
  lastReadAt?: string | null
  // True once a settings row for this card exists in the DB for this user.
  // The grid Connect button is enabled ONLY when this is true; the gear
  // (settings) button stays enabled so the user can create the row first.
  settingsPersisted?: boolean
  // Gmail cards get a stable id used by the real OAuth + scan backend.
  cardId?: 'gmail-personal' | 'gmail-professional'
  // Slack card gets its own stable id used by the real Slack OAuth + scan backend.
  slackCardId?: 'slack-workspace'
  // Local UI state for the Gmail read/parse flow.
  scanning?: boolean
  scan?: GmailScan | null
  // Gmail ingestion (gmail-calibrate worker) progress. `ingesting` while the
  // job runs; `ingestDone` once complete; `ingestedCount` = emails ingested,
  // read from the DB (email_message count) via /api/gmail/ingest-status.
  ingesting?: boolean
  ingestDone?: boolean
  ingestedCount?: number | null
  // Local UI state for the Slack 1-month read flow.
  slackScan?: SlackScan | null
  slackTeam?: string | null
  // WhatsApp live state (real Baileys backend).
  wa?: WaStatus | null
  // Chorale (voice recorder) state. A Google Drive folder must be selected and
  // write access granted to Entwin before the recorder can be turned on.
  choraleFolderSelected?: boolean
  choraleWriteAccess?: boolean
  choraleFolderName?: string | null
  choraleFolderId?: string | null
  // Chorale "Turn-on Recorder": when armed, Chorale ingests new Meet native
  // recordings from the configured Drive folder into Babelscribe. Arming never
  // starts a Meet recording — it only enables ingest of what Meet writes.
  choraleRecorderArmed?: boolean
  // Transient: the arm/disarm toggle is in flight.
  choraleRecorderBusy?: boolean
  // Drive-ingest cards (drive-personal / drive-professional): read-only OAuth →
  // folder selection → diff-based Memory Note ingestion (Read Me). These back
  // the card's transient ingest UI.
  driveIngestFolder?: string | null // human-readable path of the watched folder
  driveIngesting?: boolean // first-connect / forced-refresh pass in flight
  driveIngestDone?: boolean // a pass has completed at least once
  driveDispatched?: boolean // the pass was dispatched as a GitHub Action (vs in-process)
  driveNotesWritten?: number // notes written by the last pass
  driveFilesIngested?: number // files ingested by the last pass
}

const INITIAL_CONNECTORS: Connector[] = [
  { name: 'Gmail — Personal', service: 'gmail', icon: 'gmail', cardId: 'gmail-personal', key: 'gmail-personal', desc: 'Email ingestion for the vault.', connected: false, connectedEmail: null, scan: null },
  { name: 'Gmail — Professional', service: 'gmail', icon: 'gmail', cardId: 'gmail-professional', key: 'gmail-professional', desc: 'Email ingestion for the vault.', connected: false, connectedEmail: null, scan: null },
  { name: 'Google Drive — Personal', service: 'drive', icon: 'drive', key: 'drive-personal', desc: 'Document ingestion for the vault.', connected: false, connectedEmail: null },
  { name: 'Chorale: The Voice Recorder', service: 'drive', icon: 'chorale', key: 'chorale-recorder', desc: '', connected: false, connectedEmail: null, choraleFolderSelected: false, choraleWriteAccess: false, choraleFolderName: null, choraleFolderId: null, choraleRecorderArmed: false },
  { name: 'Google Calendar', service: null, icon: 'calendar', key: 'calendar', desc: 'Meeting and scheduling context.', connected: false, connectedEmail: null },
  { name: 'WhatsApp', service: 'whatsapp', code: 'WA', key: 'whatsapp', desc: 'Personal messages, vectorized into cross-channel memory.', connected: false, connectedEmail: null, wa: null },
  { name: 'Animatics', service: null, icon: 'animatics', key: 'animatics', desc: 'Create Anime from your Novel', connected: false, connectedEmail: null },
  { name: 'Slack', service: 'slack', icon: 'slack', slackCardId: 'slack-workspace', key: 'slack-workspace', desc: 'Work channel ingestion — pulls the last 1 month of Slack chats.', connected: false, connectedEmail: null, slackScan: null },
  { name: 'Babelscribe', service: null, icon: 'babelscribe', key: 'browser-history', desc: 'Search activity as raw source.', connected: false, connectedEmail: null },
]

/**
 * Persist one connector card's state for the current user. Fire-and-forget:
 * `connected` alone records a Connect/Disconnect click, `settings` alone records
 * a "Save settings" click; either may be sent without disturbing the other.
 * Returns true on success so callers that need to confirm (the modal) can.
 */
/** Compact "time ago" for the connector Last-read line. */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'Never'
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}

async function persistConnectorState(
  connectorKey: string,
  patch: { connected?: boolean; settings?: ConnectorSettings },
): Promise<boolean> {
  try {
    const res = await fetch('/api/connectors/state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorKey, ...patch }),
    })
    return res.ok
  } catch {
    return false
  }
}

const LIST_LABELS: Record<ListKey, string> = { marketing: 'Marketing', updates: 'Updates', people: 'People' }

const MOVE_RULES: Record<string, string> = {
  'marketing>people': 'Backfill: a full Memory Note will be created for every past email from this sender, dated to when each was originally received.',
  'people>marketing': 'No deletion. Existing Memory Notes stand untouched. New mail from this sender will log into the Ignored Daily Note instead.',
  'marketing>updates': 'Backfill: Daily Updates Note entries will be created for every past email, inserted into each original date\u2019s daily note.',
  'updates>marketing': 'No deletion. Existing Daily Updates entries stand. New mail will log into the Ignored Daily Note instead.',
  'updates>people': 'Backfill: a full Memory Note will be created for every past email. Existing Daily Updates entries are not removed, both now exist side by side.',
  'people>updates': 'No deletion. Existing Memory Notes stand untouched. New mail will log into the Daily Updates Note instead (narrow LLM summary).',
}

interface Sender { id: string; name: string; email: string; list: ListKey; isNew: boolean }
const INITIAL_SENDERS: Sender[] = [
  { id: 's1', name: 'enews.merewards.sg', email: 'delights@enews.merewards.sg', list: 'marketing', isNew: true },
  { id: 's2', name: 'LinkedIn', email: 'noreply@linkedin.com', list: 'marketing', isNew: true },
  { id: 's3', name: 'XYZ Store', email: 'offers@xyz-store.com', list: 'marketing', isNew: false },
  { id: 's4', name: 'ICICI Bank', email: 'services@custcomm.icici.bank.in', list: 'updates', isNew: true },
  { id: 's5', name: 'DBS iBanking', email: 'ibanking.alert@dbs.com', list: 'updates', isNew: false },
  { id: 's6', name: 'Dave Navarro', email: 'dave.n@gmail.com', list: 'people', isNew: false },
  { id: 's7', name: 'Priya Menon', email: 'priya.menon@gmail.com', list: 'people', isNew: true },
  { id: 's8', name: 'Rajesh Iyer', email: 'r.iyer@entwin.ai', list: 'people', isNew: false },
]

interface Entity { id: string; name: string; candidateId: string; candidateName: string; confidence: number; noteId: string; flaggedDate: string; aliases: string }
const INITIAL_ENTITIES: Entity[] = [
  { id: 'e1', name: 'Dave N.', candidateId: 'person_davenavarro', candidateName: 'Dave Navarro', confidence: 72, noteId: 'note_0648', flaggedDate: '2026-07-18', aliases: 'DN, dave.n@gmail.com' },
  { id: 'e2', name: 'R. Iyer', candidateId: 'person_rajeshiyer', candidateName: 'Rajesh Iyer', confidence: 65, noteId: 'note_0651', flaggedDate: '2026-07-19', aliases: 'R. Iyer, r.iyer@entwin.ai' },
]

const PROVIDER_MODELS: Record<ProviderKey, string[]> = {
  claude: ['Claude Opus 4.8 (latest)', 'Claude Sonnet 5 (latest)', 'Claude Haiku 4.5 (latest)'],
  gemini: ['Gemini 3.1 Pro (latest)', 'Gemini 3.6 Flash (latest)', 'Gemini 3.5 Flash-Lite (latest)'],
  openai: ['GPT-5.6 Sol (latest)', 'GPT-5.6 Terra (latest)', 'GPT-5.6 Luna (latest)'],
  neocloud: ['DeepSeek V4 Pro', 'GLM-5.2', 'Kimi K2.6'],
  onprem: ['Qwen 3.6 27B', 'Llama 4 Maverick', 'Gemma 4 27B'],
}
const SELF_HOSTED: Partial<Record<ProviderKey, boolean>> = { neocloud: true, onprem: true }

/* ---------------- Small SVG helpers ---------------- */

const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
  </svg>
)

/* ---------------- Login screen (real Google OAuth) ---------------- */

function LoginScreen() {
  const [busy, setBusy] = useState(false)

  const handleGoogle = () => {
    setBusy(true)
    // Real Google OAuth via NextAuth — redirects to accounts.google.com
    signIn('google', { callbackUrl: '/' })
  }

  return (
    <div id="login-screen" style={{ display: 'flex' }}>
      <div className="login-card">
        <div className="login-logo-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_DATA_URI} width={28} height={28} alt="" style={{ flexShrink: 0, objectFit: 'contain' }} />
          <span className="wordmark">Entwin</span>
        </div>
        <div className="login-title">Sign in</div>
        <div className="login-sub">Your second brain, wherever you left it.</div>

        <button className="google-btn" id="google-login-btn" onClick={handleGoogle} disabled={busy}>
          <GoogleG />
          <span>{busy ? 'Redirecting…' : 'Continue with Google'}</span>
        </button>

        <div className="login-footer">By continuing, you agree to Entwin&apos;s Terms and acknowledge the Privacy Policy.</div>
      </div>
    </div>
  )
}

/* ---------------- Chat view ---------------- */

interface AskSource { n: number; url: string | null; date: string | null; urgency: string | null }
interface ChatMsg { role: 'user' | 'assistant'; text: string; sources?: AskSource[]; error?: boolean }

/** Mint a conversation id (crypto.randomUUID with a safe fallback). */
function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function ChatView({
  currentModel,
  resetKey,
  onPersisted,
}: {
  currentModel: string
  resetKey: number
  onPersisted?: () => void
}) {
  const GREETING =
    'Hi, I\u2019m Entwin. Ask me anything about your email \u2014 what\u2019s outstanding, who\u2019s waiting on you, upcoming payments or deadlines \u2014 and I\u2019ll answer from your vault.'
  const [messages, setMessages] = useState<ChatMsg[]>([{ role: 'assistant', text: GREETING }])
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // One conversation id per chat session. Regenerated on "New chat" (resetKey).
  const clientIdRef = useRef<string>(newClientId())

  useEffect(() => {
    if (resetKey > 0) {
      clientIdRef.current = newClientId()
      setMessages([{ role: 'assistant', text: 'New chat started. What would you like to know?' }])
    }
  }, [resetKey])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, pending])

  /**
   * Persist the given turns for the current conversation, exactly as rendered.
   * Fire-and-forget: a storage hiccup must never block the chat UX.
   */
  const persistTurns = async (turns: ChatMsg[]) => {
    try {
      const payload = turns.map((t) => ({
        role: t.role,
        text: t.text,
        sources: t.sources ?? [],
        isError: !!t.error,
        model: currentModel || null,
      }))
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientIdRef.current, turns: payload }),
      })
      onPersisted?.()
    } catch {
      /* best-effort persistence */
    }
  }

  const send = async () => {
    const text = value.trim()
    if (!text || pending) return
    const userTurn: ChatMsg = { role: 'user', text }
    setMessages((m) => [...m, userTurn])
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setPending(true)

    let assistantTurn: ChatMsg
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Distinguish the "no LLM key set" case so the user knows to fix Settings.
        const msg = data.needsKey
          ? 'I don\u2019t have an LLM key configured yet. Add your provider and API key in Settings, then ask again.'
          : `Sorry \u2014 I couldn\u2019t answer that. ${data.error || `(error ${res.status})`}`
        assistantTurn = { role: 'assistant', text: msg, error: true }
      } else {
        assistantTurn = {
          role: 'assistant',
          text: data.answer || 'No answer returned.',
          sources: data.sources || [],
        }
      }
    } catch (e) {
      assistantTurn = { role: 'assistant', text: `Network error: ${(e as Error).message}`, error: true }
    }

    setMessages((m) => [...m, assistantTurn])
    setPending(false)
    // Persist the user question and Entwin's reply as one ordered pair.
    void persistTurns([userTurn, assistantTurn])
  }

  return (
    <>
      <div id="chat-messages" ref={listRef}>
        {messages.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <div className="role-label">{m.role === 'user' ? 'You' : 'Entwin'}</div>
            <div className="bubble" style={m.error ? { color: '#e53935' } : undefined}>{m.text}</div>
            {m.sources && m.sources.length > 0 && (
              <div className="msg-sources" style={{ marginTop: 6, fontSize: 12, opacity: 0.8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {m.sources.map((s) => (
                  s.url ? (
                    <a key={s.n} href={s.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                      [{s.n}] {s.date || 'email'}{s.urgency ? ` \u00b7 ${s.urgency}` : ''}
                    </a>
                  ) : (
                    <span key={s.n}>[{s.n}] {s.date || 'email'}</span>
                  )
                ))}
              </div>
            )}
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            <div className="role-label">Entwin</div>
            <div className="bubble">Searching your vault…</div>
          </div>
        )}
      </div>
      <div className="chat-input-wrap">
        <div className="chat-input-box">
          <textarea
            id="chat-input"
            ref={taRef}
            rows={1}
            placeholder="Message Entwin..."
            value={value}
            disabled={pending}
            onChange={(e) => {
              setValue(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 160) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="send-btn" id="send-btn" aria-label="Send message" onClick={send} disabled={pending}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
          </button>
        </div>
      </div>
    </>
  )
}

/* ---------------- WhatsApp connect popup ---------------- */

type WaModalPhase = 'input' | 'submitting' | 'pairing' | 'connected' | 'error'

function WhatsAppModal({
  onClose,
  onLinked,
}: {
  onClose: () => void
  onLinked: () => void
}) {
  const [phase, setPhase] = useState<WaModalPhase>('input')
  const [phone, setPhone] = useState('')
  const [via, setVia] = useState<'workflow' | 'local' | null>(null)
  const [runsUrl, setRunsUrl] = useState<string | null>(null)
  const [instruction, setInstruction] = useState<string>('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const digits = phone.replace(/\D/g, '')
  const valid = digits.length >= 8 && digits.length <= 15

  const submit = async () => {
    if (!valid) {
      setError('Enter your number in international format including the ISD code, e.g. +1 312 555 1234')
      return
    }
    setError(null)
    setPhase('submitting')
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits }),
      })
      const raw = await res.text()
      let payload: any = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        /* ignore */
      }
      if (!res.ok) throw new Error(payload.error || `Connect failed (${res.status})`)
      setVia(payload.via ?? 'workflow')
      setRunsUrl(payload.runsUrl ?? null)
      setInstruction(payload.message ?? '')
      setPhase('pairing')
      startPolling()
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/status')
        if (!res.ok) return
        const st = await res.json()
        // Surface the code as soon as the pairing job publishes it.
        if (st.pairingCode) setPairingCode(st.pairingCode as string)
        if (st.linked || st.state === 'connected') {
          if (pollRef.current) clearInterval(pollRef.current)
          setPairingCode(null)
          setPhase('connected')
          finishLinked()
        }
      } catch {
        /* transient — keep polling */
      }
    }, 4000)
  }

  const finishLinked = () => {
    // Nudge an immediate capture+vectorize run rather than waiting for the hour.
    fetch('/api/whatsapp/ingest', { method: 'POST' }).catch(() => {})
    setTimeout(() => {
      onLinked()
      onClose()
    }, 1600)
  }

  return (
    <div className="wa-overlay" role="dialog" aria-modal="true" aria-label="Connect WhatsApp">
      <div className="wa-window">
        <div className="wa-head">
          <div className="wa-badge">WA</div>
          <div className="wa-head-title">Connect WhatsApp</div>
          <button className="wa-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {phase === 'input' || phase === 'submitting' || phase === 'error' ? (
          <div className="wa-body">
            <p className="wa-lead">
              Enter your WhatsApp number, including the ISD / country code. Entwin links as a device on your
              own account (like WhatsApp Web) and then ingests messages once an hour \u2014 no app stays
              connected in the background.
            </p>
            <label className="wa-label" htmlFor="wa-phone">
              Phone number
            </label>
            <input
              id="wa-phone"
              className="wa-input"
              type="tel"
              inputMode="tel"
              autoFocus
              placeholder="+1 312 555 1234"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid && phase !== 'submitting') submit()
              }}
              disabled={phase === 'submitting'}
            />
            {error && <div className="wa-error">{error}</div>}
            <div className="wa-actions">
              <button className="wa-btn ghost" onClick={onClose} disabled={phase === 'submitting'}>
                Cancel
              </button>
              <button className="wa-btn primary" onClick={submit} disabled={!valid || phase === 'submitting'}>
                {phase === 'submitting' ? 'Starting…' : 'Start pairing'}
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'pairing' ? (
          <div className="wa-body">
            {via === 'local' ? (
              <>
                <p className="wa-lead">Run this once to link the device, then enter the printed code on your phone:</p>
                <pre className="wa-cmd">{instruction}</pre>
              </>
            ) : pairingCode ? (
              <>
                <p className="wa-lead">
                  Enter this pairing code on your phone: WhatsApp → Settings → Linked devices → Link with phone
                  number.
                </p>
                <div className="wa-paircode" aria-label="WhatsApp pairing code">
                  {pairingCode.split('').map((ch, i) =>
                    ch === '-' ? (
                      <span key={i} className="wa-paircode-sep">–</span>
                    ) : (
                      <span key={i} className="wa-paircode-ch">{ch}</span>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="wa-link wa-copy"
                  onClick={() => navigator.clipboard?.writeText(pairingCode.replace(/-/g, '')).catch(() => {})}
                >
                  Copy code
                </button>
              </>
            ) : (
              <>
                <p className="wa-lead">
                  Pairing has started in a background job. Your code will appear here in a few seconds…
                </p>
                {runsUrl && (
                  <a className="wa-link" href={runsUrl} target="_blank" rel="noreferrer">
                    Or open the pairing job log ↗
                  </a>
                )}
              </>
            )}
            <div className="wa-waiting">
              <span className="wa-spinner" /> Waiting for the device to link…
            </div>
            <p className="wa-fineprint">
              Once linked, Entwin ingests your last 30 days of messages, then batches new ones every hour. This
              window updates automatically when pairing completes.
            </p>
          </div>
        ) : null}

        {phase === 'connected' ? (
          <div className="wa-body wa-success">
            <div className="wa-check">✓</div>
            <div className="wa-success-title">WhatsApp linked</div>
            <p className="wa-fineprint">
              Ingesting the last 30 days now. New messages sync every hour and feed the same memory as your
              email.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ---------------- Babelscribe modal ---------------- */

type BabelPhase = 'input' | 'submitting' | 'running' | 'ready' | 'failed' | 'error'

function BabelscribeModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<BabelPhase>('input')
  const [path, setPath] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Live current-activity label from the workflow (e.g. "Set up job",
  // "Transcribe + translate"). Defaults to a neutral queued state.
  const [phaseLabel, setPhaseLabel] = useState<string>('Queued')
  const [downloading, setDownloading] = useState(false)

  // Light client-side check that the path contains something id-like, so we can
  // enable the button. The server does the authoritative extraction/validation.
  const looksValid =
    /\/d\/[a-zA-Z0-9_-]{10,}/.test(path) ||
    /[?&]id=[a-zA-Z0-9_-]{10,}/.test(path) ||
    /^[a-zA-Z0-9_-]{10,}$/.test(path.trim())

  const submit = async () => {
    if (!looksValid) {
      setError('Paste a Google Drive share link (…/file/d/<id>/view) or the bare file id.')
      return
    }
    setError(null)
    setPhase('submitting')
    try {
      const res = await fetch('/api/babelscribe/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drivePath: path.trim() }),
      })
      const raw = await res.text()
      let payload: any = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        /* ignore */
      }
      if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`)
      setRunId(payload.runId ?? null)
      setMessage(payload.message ?? 'Transcription in-progress.')
      setPhaseLabel('Queued')
      setPhase('running')
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  // Poll the workflow run for its live step + completion while we're running.
  useEffect(() => {
    if (phase !== 'running' || !runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/babelscribe/status?runId=${encodeURIComponent(runId)}`,
          { cache: 'no-store' },
        )
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok && data?.ok) {
          if (data.phaseLabel) setPhaseLabel(data.phaseLabel)
          if (data.done) {
            if (data.failed) {
              setError('The transcription run did not complete successfully.')
              setPhase('failed')
              return
            }
            if (data.artifactReady) {
              setPhase('ready')
              return
            }
            // Completed successfully but artifact not yet listed — keep polling
            // briefly for the upload to settle.
            setPhaseLabel('Finalizing')
          }
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) timer = setTimeout(poll, 4000)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [phase, runId])

  // Fetch transcript.pdf and trigger a browser download.
  const downloadTranscript = async () => {
    if (!runId) return
    setDownloading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/babelscribe/transcript?runId=${encodeURIComponent(runId)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || `Download failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'transcript.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="wa-overlay" role="dialog" aria-modal="true" aria-label="Babelscribe — transcribe Google Drive audio">
      <div className="wa-window">
        <div className="wa-head">
          <div className="wa-badge" style={{ background: '#20325A' }}>BS</div>
          <div className="wa-head-title">Babelscribe — GDrive audio</div>
          <button className="wa-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {phase === 'input' || phase === 'submitting' || phase === 'error' ? (
          <div className="wa-body">
            <p className="wa-lead">
              Paste the Google Drive path to a multi-lingual audio file. Babelscribe produces one English
              transcript, keeping any non-English speech translated but wrapped in brackets (e.g.{' '}
              <code>[hi: …]</code>). The result PDF is emailed to your login address. The file must have
              “anyone with the link” read access.
            </p>
            <label className="wa-label" htmlFor="bs-path">
              Google Drive audio path
            </label>
            <input
              id="bs-path"
              className="wa-input"
              type="text"
              autoFocus
              placeholder="https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && looksValid && phase !== 'submitting') submit()
              }}
              disabled={phase === 'submitting'}
            />
            {error && <div className="wa-error">{error}</div>}
            <div className="wa-actions">
              <button className="wa-btn ghost" onClick={onClose} disabled={phase === 'submitting'}>
                Cancel
              </button>
              <button className="wa-btn primary" onClick={submit} disabled={!looksValid || phase === 'submitting'}>
                {phase === 'submitting' ? 'Starting…' : 'Transcribe'}
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'running' ? (
          <div className="wa-body wa-success">
            <div className="wa-check wa-check-spin" style={{ background: '#20325A' }}>
              <span className="wa-spinner" aria-hidden="true" />
            </div>
            <div className="wa-success-title">Transcription in-progress</div>
            <p className="wa-fineprint">{message}</p>
            {/* Live current step of the GitHub Actions run, in place of the old
                "Open the transcription job" link. */}
            <div className="wa-link wa-phase" aria-live="polite">
              <span className="wa-phase-dot" aria-hidden="true" />
              {phaseLabel}
            </div>
            {error && <div className="wa-error">{error}</div>}
            <div className="wa-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button className="wa-btn ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <div className="wa-body wa-success">
            <div className="wa-check" style={{ background: '#20325A' }}>✓</div>
            <div className="wa-success-title">Transcript ready</div>
            <p className="wa-fineprint">
              Your English transcript is ready. It was also emailed to your login address.
            </p>
            {/* Same slot as the old job link — now a downloadable transcript. */}
            <button
              className="wa-link wa-link-btn"
              onClick={downloadTranscript}
              disabled={downloading}
            >
              {downloading ? 'Preparing…' : 'Transcript Link ⬇'}
            </button>
            {error && <div className="wa-error">{error}</div>}
            <div className="wa-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button className="wa-btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'failed' ? (
          <div className="wa-body wa-success">
            <div className="wa-check" style={{ background: '#8a2b2b' }}>×</div>
            <div className="wa-success-title">Transcription failed</div>
            <p className="wa-fineprint">
              {error || 'The run did not complete successfully. Check your Drive link’s share access and try again.'}
            </p>
            <div className="wa-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button className="wa-btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ---------------- Chorale "Configure GDrive" (URL) modal ---------------- */

type ChoraleUrlPhase = 'input' | 'saving' | 'redirecting' | 'saved' | 'error'

/**
 * Collects a Google Drive folder URL for Chorale's write destination and saves
 * it. The folder should be a (shared-drive) folder that Entwin has write access
 * to. On submit we POST the URL to /api/drive/select-url:
 *   - { ok: true }        -> folder resolved, write access verified, saved.
 *   - { needsAuth: true } -> no Drive write token yet; hand off to Google's
 *                            consent screen, carrying the URL so it's saved on
 *                            return (?drive=saved).
 *   - { error }           -> surfaced inline (bad link / no write access / etc).
 */
function ChoraleDriveUrlModal({
  card,
  currentFolderName,
  onSaved,
  onClose,
}: {
  card: string
  currentFolderName: string | null
  onSaved: (folder: { id: string; name: string; path: string }) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<ChoraleUrlPhase>('input')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Light client-side check so the button enables only for something folder-like.
  const looksValid =
    /\/folders\/[a-zA-Z0-9_-]{10,}/.test(url) ||
    /[?&]id=[a-zA-Z0-9_-]{10,}/.test(url) ||
    /\/d\/[a-zA-Z0-9_-]{10,}/.test(url) ||
    /^[a-zA-Z0-9_-]{10,}$/.test(url.trim())

  const submit = async () => {
    if (!looksValid) {
      setError(
        'Paste a Google Drive folder link, e.g. https://drive.google.com/drive/folders/FOLDER_ID',
      )
      return
    }
    setError(null)
    setPhase('saving')
    try {
      const res = await fetch('/api/drive/select-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card, folderUrl: url.trim() }),
      })
      const raw = await res.text()
      let payload: any = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        /* ignore */
      }

      if (res.ok && payload.needsAuth) {
        // No write token yet — hand off to Google consent, carrying the URL so
        // the same folder is auto-saved when we come back (?drive=saved).
        setPhase('redirecting')
        window.location.href = `/api/drive/authorize?card=${encodeURIComponent(
          card,
        )}&folderUrl=${encodeURIComponent(url.trim())}`
        return
      }

      if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`)

      const folder = payload.selectedFolder as { id: string; name: string; path: string } | undefined
      if (!folder) throw new Error('The folder could not be saved. Please try again.')
      setPhase('saved')
      onSaved(folder)
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  const busy = phase === 'saving' || phase === 'redirecting'

  return (
    <div
      className="wa-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Chorale — configure Google Drive folder"
    >
      <div className="wa-window">
        <div className="wa-head">
          <div className="wa-badge" style={{ background: '#20325A' }}>
            <img src="/chorale-icon.png" alt="" width={20} height={20} style={{ display: 'block' }} />
          </div>
          <div className="wa-head-title">Chorale — Configure GDrive</div>
          <button className="wa-close" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <div className="wa-body">
          <p className="wa-lead">
            Paste a Google Drive URL for the folder where Chorale should save recordings. Use a{' '}
            <strong>shared-drive folder that Entwin has write (Editor) access to</strong>. We&apos;ll
            verify write access and save this folder as the recording destination.
          </p>
          {currentFolderName && (
            <p className="wa-fineprint" style={{ marginTop: 0 }}>
              Current destination: <strong>{currentFolderName}</strong>
            </p>
          )}
          <label className="wa-label" htmlFor="chorale-drive-url">
            Google Drive folder URL
          </label>
          <input
            id="chorale-drive-url"
            className="wa-input"
            type="text"
            autoFocus
            placeholder="https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && looksValid && !busy) submit()
            }}
            disabled={busy}
          />
          {error && <div className="wa-error">{error}</div>}
          <div className="wa-actions">
            <button className="wa-btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="wa-btn primary" onClick={submit} disabled={!looksValid || busy}>
              {phase === 'saving'
                ? 'Saving…'
                : phase === 'redirecting'
                ? 'Redirecting to Google…'
                : 'Save folder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Chorale recorder modal (system/tab audio) ---------------- */

type RecPhase = 'idle' | 'recording' | 'recorded' | 'uploading' | 'uploaded' | 'error'

function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * In-browser recorder that captures computer/tab audio via the browser's
 * screen-share picker (getDisplayMedia), lets the user start/stop, upload the
 * result into the configured Google Drive folder, and download it locally.
 *
 * Browser reality: a web page can't silently capture all system audio — the
 * browser MUST show its share picker and the user must tick "share audio". On
 * Chrome, choosing a TAB with "share tab audio" captures that tab's audio (e.g.
 * a Meet call = all participants). Choosing "Entire screen" can capture full
 * system audio on Windows; macOS restricts system-audio capture. If the user's
 * mic should also be captured, we mix it in when available.
 */
function ChoraleRecorderModal({
  card,
  folderName,
  onClose,
}: {
  card: string
  folderName: string
  onClose: () => void
}) {
  const [phase, setPhase] = useState<RecPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [includeMic, setIncludeMic] = useState(true)
  const [uploadedLink, setUploadedLink] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const blobRef = useRef<Blob | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileName = useRef<string>('')

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const cleanupStreams = () => {
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streamsRef.current = []
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      stopTimer()
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
      cleanupStreams()
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickMime = (): string => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
    }
    return 'audio/webm'
  }

  const start = async () => {
    setError(null)
    setUploadedLink(null)
    try {
      // System/tab audio via the screen-share picker. We only need audio, but
      // the API requires requesting video too; we stop the video track right
      // away and keep only audio.
      const display = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({
        video: true,
        audio: true,
      })
      streamsRef.current.push(display)
      const displayAudio = display.getAudioTracks()
      // Drop the video track — we're recording audio only.
      display.getVideoTracks().forEach((t) => t.stop())

      if (displayAudio.length === 0) {
        cleanupStreams()
        setError(
          'No audio was shared. Re-open the picker and enable “Share tab audio” (or pick “Entire screen” with system audio).',
        )
        setPhase('error')
        return
      }

      // Optionally mix in the mic so the user's own voice is captured too.
      let micStream: MediaStream | null = null
      if (includeMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          streamsRef.current.push(micStream)
        } catch {
          // Mic denied/unavailable — proceed with system audio only.
          micStream = null
        }
      }

      // Build the stream to record. If we have both display + mic, mix them via
      // Web Audio into a single destination; otherwise record display audio.
      let recordStream: MediaStream
      if (micStream) {
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const dest = ctx.createMediaStreamDestination()
        ctx.createMediaStreamSource(new MediaStream(displayAudio)).connect(dest)
        ctx.createMediaStreamSource(micStream).connect(dest)
        recordStream = dest.stream
      } else {
        recordStream = new MediaStream(displayAudio)
      }

      const mimeType = pickMime()
      const mr = new MediaRecorder(recordStream, { mimeType })
      chunksRef.current = []
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        blobRef.current = blob
        setAudioUrl(URL.createObjectURL(blob))
        cleanupStreams()
        setPhase('recorded')
      }
      // If the user stops sharing via the browser's own "Stop sharing" UI, end.
      displayAudio[0].addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop()
        }
        stopTimer()
      })

      recorderRef.current = mr
      fileName.current = `chorale-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
      mr.start()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
      setPhase('recording')
    } catch (e) {
      cleanupStreams()
      const msg = (e as Error).message || 'Screen/audio capture was denied.'
      setError(msg)
      setPhase('error')
    }
  }

  const stop = () => {
    stopTimer()
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
  }

  const uploadToDrive = async () => {
    if (!blobRef.current) return
    setError(null)
    setPhase('uploading')
    try {
      const fd = new FormData()
      fd.append('card', card)
      fd.append('name', fileName.current || 'chorale-recording.webm')
      fd.append('file', blobRef.current, fileName.current || 'chorale-recording.webm')
      const res = await fetch('/api/drive/upload-recording', { method: 'POST', body: fd })
      const raw = await res.text()
      let payload: any = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        /* ignore */
      }
      if (!res.ok) throw new Error(payload.error || `Upload failed (${res.status})`)
      setUploadedLink(payload.file?.webViewLink ?? null)
      setPhase('uploaded')
    } catch (e) {
      setError((e as Error).message)
      setPhase('recorded')
    }
  }

  const reset = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
    blobRef.current = null
    chunksRef.current = []
    setElapsed(0)
    setUploadedLink(null)
    setError(null)
    setPhase('idle')
  }

  const recording = phase === 'recording'
  const busy = phase === 'uploading'

  return (
    <div className="wa-overlay" role="dialog" aria-modal="true" aria-label="Chorale — recorder">
      <div className="wa-window">
        <div className="wa-head">
          <div className="wa-badge" style={{ background: '#20325A' }}>
            <img src="/chorale-icon.png" alt="" width={20} height={20} style={{ display: 'block' }} />
          </div>
          <div className="wa-head-title">Chorale — Recorder</div>
          <button className="wa-close" aria-label="Close" onClick={onClose} disabled={recording || busy}>
            ×
          </button>
        </div>

        <div className="wa-body">
          <p className="wa-lead">
            Records your computer/tab audio and saves it to <strong>{folderName}</strong>. When you
            start, your browser asks which screen or tab to share — pick the meeting tab and enable
            <strong> “Share tab audio”</strong> to capture all participants. (Browsers require this
            picker; audio can’t be captured silently.)
          </p>

          <div className="chorale-recorder-stage">
            <div className={`chorale-pulse ${recording ? 'live' : ''}`} aria-hidden="true" />
            <div className="chorale-timer">{mmss(elapsed)}</div>
            <div className="chorale-state">
              {phase === 'idle' && 'Ready'}
              {phase === 'recording' && 'Recording…'}
              {phase === 'recorded' && 'Recorded'}
              {phase === 'uploading' && 'Uploading to Drive…'}
              {phase === 'uploaded' && 'Saved to Drive'}
              {phase === 'error' && 'Error'}
            </div>
          </div>

          {phase === 'idle' && (
            <label className="chorale-mic-opt">
              <input
                type="checkbox"
                checked={includeMic}
                onChange={(e) => setIncludeMic(e.target.checked)}
              />
              Also record my microphone (mix my voice in)
            </label>
          )}

          {audioUrl && (phase === 'recorded' || phase === 'uploaded' || phase === 'uploading') && (
            <audio className="chorale-audio" src={audioUrl} controls />
          )}

          {error && <div className="wa-error">{error}</div>}

          {uploadedLink && (
            <a className="wa-link" href={uploadedLink} target="_blank" rel="noreferrer">
              Open the recording in Google Drive ↗
            </a>
          )}

          <div className="wa-actions">
            {phase === 'idle' && (
              <>
                <button className="wa-btn ghost" onClick={onClose}>
                  Cancel
                </button>
                <button className="wa-btn primary" onClick={start}>
                  Start recording
                </button>
              </>
            )}

            {phase === 'recording' && (
              <button className="wa-btn primary" onClick={stop}>
                Stop recording
              </button>
            )}

            {(phase === 'recorded' || phase === 'uploading' || phase === 'uploaded') && (
              <>
                <button className="wa-btn ghost" onClick={reset} disabled={busy}>
                  New recording
                </button>
                {audioUrl && (
                  <a
                    className="wa-btn ghost"
                    href={audioUrl}
                    download={fileName.current || 'chorale-recording.webm'}
                  >
                    Download
                  </a>
                )}
                {phase !== 'uploaded' && (
                  <button className="wa-btn primary" onClick={uploadToDrive} disabled={busy}>
                    {busy ? 'Uploading…' : 'Save to Drive'}
                  </button>
                )}
                {phase === 'uploaded' && (
                  <button className="wa-btn primary" onClick={onClose}>
                    Done
                  </button>
                )}
              </>
            )}

            {phase === 'error' && (
              <>
                <button className="wa-btn ghost" onClick={onClose}>
                  Close
                </button>
                <button className="wa-btn primary" onClick={reset}>
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Google Drive folder explorer ---------------- */

interface DriveExplorerFolder {
  id: string
  name: string
}

// One level in the breadcrumb trail as the user drills into Drive. `root` is
// "My Drive"; each subsequent crumb is a folder the user opened.
interface DriveCrumb {
  id: string
  name: string
}

// Modal that browses the user's Google Drive folder tree (via /api/drive/folders)
// and lets them pick a destination folder for Chorale recordings. Opened right
// after the Drive write-access consent returns. On "Use this folder" it persists
// the choice (/api/drive/select) and hands the folder id/name/path back to the
// card, then closes.
function DriveExplorerModal({
  card,
  connectedEmail,
  onSelect,
  onClose,
}: {
  card: string
  connectedEmail?: string | null
  onSelect: (folder: { id: string; name: string; path: string }) => void
  onClose: () => void
}) {
  // Breadcrumb trail; always starts at My Drive (root).
  const [trail, setTrail] = useState<DriveCrumb[]>([{ id: 'root', name: 'My Drive' }])
  const [folders, setFolders] = useState<DriveExplorerFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const current = trail[trail.length - 1]
  const pathString = trail.map((c) => c.name).join(' / ')

  // Load the folders under the current breadcrumb whenever it changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/drive/folders?card=${encodeURIComponent(card)}&parent=${encodeURIComponent(current.id)}`,
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `Failed to list folders (${res.status})`)
        }
        const data = (await res.json()) as { folders?: DriveExplorerFolder[] }
        if (!cancelled) setFolders(data.folders ?? [])
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Could not load Drive folders.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [card, current.id])

  // Drill into a subfolder — push it onto the trail.
  const openFolder = (f: DriveExplorerFolder) => {
    setTrail((t) => [...t, { id: f.id, name: f.name }])
  }

  // Jump back to an ancestor crumb.
  const goToCrumb = (idx: number) => {
    setTrail((t) => t.slice(0, idx + 1))
  }

  // Commit the current folder. Chorale persists it as its single write
  // destination via /api/drive/select; the Drive-ingest cards persist via
  // /api/drive/select-ingest (done in the card's onSelect handler), so for those
  // we skip the Chorale route entirely and just hand the folder back.
  const useThisFolder = async () => {
    const folder = { id: current.id, name: current.name, path: pathString }

    // Drive-ingest cards: the handler saves to /api/drive/select-ingest and runs
    // ingestion. Don't call the Chorale write route here.
    if (card === 'drive-personal' || card === 'drive-professional') {
      onSelect(folder)
      return
    }

    setSaving(true)
    setError(null)
    try {
      // Persist server-side. Best-effort: if it fails we still hand the folder
      // to the card so the flow isn't blocked, and surface a soft error.
      const res = await fetch('/api/drive/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card,
          folderId: folder.id,
          folderName: folder.name,
          folderPath: folder.path,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Could not save selection (${res.status})`)
      }
      onSelect(folder)
    } catch (e) {
      // Non-fatal: still complete the selection locally so the user isn't stuck.
      setError((e as Error).message || 'Selection could not be saved to the server.')
      onSelect(folder)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wa-overlay" role="dialog" aria-modal="true" aria-label="Choose a Google Drive folder">
      <div className="wa-window drive-window">
        <div className="wa-head">
          <div className="wa-badge drive-badge" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </div>
          <div className="wa-head-title">
            Select a Google Drive folder
            {connectedEmail ? <span className="drive-account"> · {connectedEmail}</span> : null}
          </div>
          <button className="wa-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="wa-body">
          <p className="wa-lead">
            Choose the folder where Chorale should save your recordings. Open a folder to browse
            inside it, then click <strong>Use this folder</strong>.
          </p>

          {/* Breadcrumb trail */}
          <nav className="drive-breadcrumbs" aria-label="Folder path">
            {trail.map((c, i) => (
              <span key={`${c.id}-${i}`} className="drive-crumb-wrap">
                <button
                  type="button"
                  className={`drive-crumb ${i === trail.length - 1 ? 'current' : ''}`}
                  onClick={() => goToCrumb(i)}
                  disabled={i === trail.length - 1}
                >
                  {c.name}
                </button>
                {i < trail.length - 1 && <span className="drive-crumb-sep">/</span>}
              </span>
            ))}
          </nav>

          {/* Folder list */}
          <div className="drive-list" role="listbox" aria-label="Folders">
            {loading ? (
              <div className="drive-empty">Loading folders…</div>
            ) : error ? (
              <div className="wa-error">{error}</div>
            ) : folders.length === 0 ? (
              <div className="drive-empty">
                No subfolders here. You can select this folder, or go back up.
              </div>
            ) : (
              folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="drive-item"
                  onClick={() => openFolder(f)}
                  title={`Open ${f.name}`}
                >
                  <svg
                    className="drive-item-icon"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span className="drive-item-name">{f.name}</span>
                  <svg
                    className="drive-item-chevron"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))
            )}
          </div>

          <div className="drive-selected-hint">
            Selected destination: <strong>{pathString}</strong>
          </div>

          <div className="wa-actions">
            <button className="wa-btn ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="wa-btn primary" onClick={useThisFolder} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Use this folder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Connectors view ---------------- */

function ConnectorsView({
  connectors,
  setConnectors,
  runGmailScan,
  openWhatsApp,
  notice,
  clearNotice,
}: {
  connectors: Connector[]
  setConnectors: React.Dispatch<React.SetStateAction<Connector[]>>
  runGmailScan: (cardId: NonNullable<Connector['cardId']>) => void
  openWhatsApp: () => void
  notice: string | null
  clearNotice: () => void
}) {
  const isGmail = (c: Connector) => c.service === 'gmail' && !!c.cardId
  const isWhatsApp = (c: Connector) => c.service === 'whatsapp'
  const isSlack = (c: Connector) => c.service === 'slack' && !!c.slackCardId
  // Drive-ingest cards use the real read-only OAuth + ingestion backend.
  const isDriveIngest = (c: Connector) =>
    c.key === 'drive-personal' || c.key === 'drive-professional'

  // Animatics Phase 1 flow modal (novel → cast → screenplay → approve).
  const [animaticsOpen, setAnimaticsOpen] = useState(false)
  // Whether an Animatics run currently exists (drives Connect/Disconnect label).
  const [animaticsConnected, setAnimaticsConnected] = useState(false)

  // Index of the connector whose settings panel is open (null = closed).
  const [settingsIdx, setSettingsIdx] = useState<number | null>(null)
  const openConnectorSettings = (idx: number) => setSettingsIdx(idx)
  const closeConnectorSettings = () => setSettingsIdx(null)

  // Babelscribe: the "Upload GDrive Audio Path" action opens a modal to collect
  // the Drive path and dispatch the transcription workflow.
  const [babelscribeOpen, setBabelscribeOpen] = useState(false)
  // Index of the connector whose Drive folder-explorer modal is open, or null.
  // Opened after the Drive write-access consent returns (?drive=connected).
  const [driveExplorerIdx, setDriveExplorerIdx] = useState<number | null>(null)
  // Index of the connector whose in-browser recorder popup is open, or null.
  const [choraleRecorderIdx, setChoraleRecorderIdx] = useState<number | null>(null)
  // Index of the connector whose "Configure GDrive" URL modal is open, or null.
  const [choraleDriveUrlIdx, setChoraleDriveUrlIdx] = useState<number | null>(null)
  // Notice shown when the Drive consent is cancelled or errors out.
  const [driveNotice, setDriveNotice] = useState<string | null>(null)

  // On mount, reflect any in-progress Animatics run so the button shows the
  // right label after a page reload.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/animatics/status')
        const d = await r.json()
        if (!cancelled) setAnimaticsConnected(!!d.job)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Chorale — "Configure GDrive": opens a small modal where the user pastes a
  // Google Drive URL pointing to a (shared-drive) folder that Entwin should have
  // WRITE access to. On submit we POST the URL to /api/drive/select-url, which
  // resolves the folder id, verifies write access, and SAVES it as the Chorale
  // destination. If Entwin doesn't hold a Drive write token for this card yet,
  // that endpoint replies { needsAuth: true } and the modal hands the user off
  // to Google's consent screen — carrying the URL through so it's saved
  // automatically on return.
  const configureChoraleDrive = (idx: number) => {
    setChoraleDriveUrlIdx(idx)
  }

  // When the URL modal saves a folder, stamp it onto the card.
  const onChoraleFolderSavedFromUrl = (
    idx: number,
    folder: { id: string; name: string; path: string },
  ) => {
    setConnectors((prev) =>
      prev.map((x, i) =>
        i === idx
          ? {
              ...x,
              choraleFolderSelected: true,
              choraleWriteAccess: true,
              choraleFolderId: folder.id,
              choraleFolderName: folder.path || folder.name,
            }
          : x,
      ),
    )
    setChoraleDriveUrlIdx(null)
  }

  // Chorale — "Turn-on Recorder": opens the in-browser recorder popup. The
  // recorder captures tab/system audio via the browser's screen-share picker,
  // lets the user start/stop, upload the result to the configured Drive folder,
  // and download it locally. Only reachable once a folder is selected and write
  // access granted (so the upload has a destination).
  const openChoraleRecorder = (idx: number) => {
    const c = connectors[idx]
    if (!(c.choraleFolderSelected && c.choraleWriteAccess)) return
    setChoraleRecorderIdx(idx)
  }

  // On mount, hydrate the Chorale card from its server-side Drive session so a
  // previously granted write scope and chosen folder survive a page refresh
  // (mirrors the Gmail/Slack hydrators). If the token/selection is gone, the
  // card falls back to needing Configure GDrive again.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const idx = connectors.findIndex((c) => c.key === 'chorale-recorder')
      if (idx < 0) return
      try {
        const res = await fetch('/api/drive/status?card=chorale-recorder')
        if (!res.ok) return
        const d = (await res.json()) as {
          state?: string
          connectedEmail?: string | null
          writeAccess?: boolean
          selectedFolder?: { id: string; name: string; path: string } | null
          recorderArmed?: boolean
        }
        if (cancelled) return
        const connected = d.state === 'connected'
        setConnectors((prev) =>
          prev.map((x) =>
            x.key === 'chorale-recorder'
              ? {
                  ...x,
                  choraleWriteAccess: connected && !!d.writeAccess,
                  choraleFolderSelected: connected && !!d.selectedFolder,
                  choraleFolderId: d.selectedFolder?.id ?? null,
                  choraleFolderName: d.selectedFolder?.path ?? d.selectedFolder?.name ?? x.choraleFolderName ?? null,
                  choraleRecorderArmed: connected && !!d.recorderArmed,
                  connectedEmail: d.connectedEmail ?? x.connectedEmail ?? null,
                }
              : x,
          ),
        )
      } catch {
        /* best-effort hydration */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On return from the Drive write-access consent (?drive=connected&card=...),
  // record that write access is granted and open the Drive Explorer so the user
  // can pick a folder. ?drive=denied / ?drive=error surface a notice instead.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const drive = params.get('drive')
    if (!drive) return

    if (drive === 'saved') {
      // The user configured the folder via the "Configure GDrive" URL modal and
      // it was auto-saved during the OAuth return. Pull the persisted folder
      // from the server so the card reflects it — no explorer needed.
      const idx = connectors.findIndex((c) => c.key === 'chorale-recorder')
      if (idx >= 0) {
        ;(async () => {
          try {
            const res = await fetch('/api/drive/status?card=chorale-recorder')
            if (!res.ok) return
            const d = (await res.json()) as {
              state?: string
              connectedEmail?: string | null
              writeAccess?: boolean
              selectedFolder?: { id: string; name: string; path: string } | null
              recorderArmed?: boolean
            }
            const connected = d.state === 'connected'
            setConnectors((prev) =>
              prev.map((x) =>
                x.key === 'chorale-recorder'
                  ? {
                      ...x,
                      choraleWriteAccess: connected && !!d.writeAccess,
                      choraleFolderSelected: connected && !!d.selectedFolder,
                      choraleFolderId: d.selectedFolder?.id ?? x.choraleFolderId ?? null,
                      choraleFolderName:
                        d.selectedFolder?.path ??
                        d.selectedFolder?.name ??
                        x.choraleFolderName ??
                        null,
                      choraleRecorderArmed: connected && !!d.recorderArmed,
                      connectedEmail: d.connectedEmail ?? x.connectedEmail ?? null,
                    }
                  : x,
              ),
            )
            if (!(connected && d.selectedFolder)) {
              setDriveNotice(
                'Google access was granted, but the folder could not be saved. Open “Configure GDrive” and re-paste the folder link.',
              )
            }
          } catch {
            /* best-effort */
          }
        })()
      }
    } else if (drive === 'savefailed') {
      // Consent succeeded but resolving/saving the pasted folder failed. Mark
      // write access granted (it was) and show the real reason so the user can
      // fix it and re-paste via "Configure GDrive".
      setConnectors((prev) =>
        prev.map((x) =>
          x.key === 'chorale-recorder' ? { ...x, choraleWriteAccess: true } : x,
        ),
      )
      const reason = params.get('reason')
      setDriveNotice(
        `Google access was granted, but the folder could not be saved${
          reason ? `: ${decodeURIComponent(reason)}` : '.'
        } Open “Configure GDrive” and re-paste the folder link.`,
      )
    } else if (drive === 'connected') {
      // The callback tells us WHICH card came back. Chorale opens the write
      // folder picker; the Drive-ingest cards open the same explorer but then
      // save folders as ingestion roots and kick off ingestion.
      const card = params.get('card') || 'chorale-recorder'
      const idx = connectors.findIndex((c) => c.key === card)
      if (idx >= 0) {
        if (card === 'drive-personal' || card === 'drive-professional') {
          // Mark connected (read access granted) and open the explorer to pick
          // ingestion folder(s).
          setConnectors((prev) =>
            prev.map((x, i) =>
              i === idx ? { ...x, connected: true, connectedEmail: x.connectedEmail } : x,
            ),
          )
          persistConnectorState(card, { connected: true })
          setDriveExplorerIdx(idx)
        } else {
          // Chorale: mark write access granted; folder selection completes in
          // the modal.
          setConnectors((prev) =>
            prev.map((x) =>
              x.key === 'chorale-recorder' ? { ...x, choraleWriteAccess: true } : x,
            ),
          )
          setDriveExplorerIdx(idx)
        }
      }
    } else if (drive === 'denied') {
      setDriveNotice('Google Drive access was cancelled — you did not grant write access.')
    } else if (drive === 'error') {
      const reason = params.get('reason')
      setDriveNotice(
        `Google Drive connection failed${reason ? `: ${decodeURIComponent(reason)}` : ''}. Please try again.`,
      )
    }
    // Clean the URL so a refresh doesn't re-trigger the flow.
    window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the user selects a folder in the Drive Explorer: stamp it onto the
  // card (folder selected + write access), close the popup.
  const onDriveFolderSelected = (
    idx: number,
    folder: { id: string; name: string; path: string },
  ) => {
    const card = connectors[idx]?.key

    // Drive-ingest cards: persist the folder as an ingestion root (Read Me §1
    // Scope), then dispatch a first-connect ingestion pass. The card shows a
    // lightweight "ingesting…" state driven by the response.
    if (card === 'drive-personal' || card === 'drive-professional') {
      setConnectors((prev) =>
        prev.map((x, i) =>
          i === idx
            ? { ...x, connected: true, driveIngestFolder: folder.path || folder.name, driveIngesting: true }
            : x,
        ),
      )
      setDriveExplorerIdx(null)
      ;(async () => {
        try {
          // Save the selected folder (replace the current selection with it).
          const sel = await fetch('/api/drive/select-ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card, folders: [folder], mode: 'replace' }),
          })
          if (!sel.ok) {
            const p = await sel.json().catch(() => ({}))
            throw new Error(p.error || `folder save failed (${sel.status})`)
          }
          // Kick off first-connection ingestion (§1: read every file in full).
          // With GitHub Actions configured this returns 202 + {dispatched:true}
          // and the run appears in the Actions tab; without Actions it runs
          // in-process and returns the completed report.
          const ing = await fetch('/api/drive/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card, trigger: 'first-connect' }),
          })
          const report = (await ing.json().catch(() => ({}))) as {
            ok?: boolean
            dispatched?: boolean
            notesWritten?: number
            filesIngested?: number
            error?: string
          }
          if (!ing.ok && !report.dispatched && !report.notesWritten) {
            throw new Error(report.error || `ingestion failed (${ing.status})`)
          }
          setConnectors((prev) =>
            prev.map((x, i) =>
              i === idx
                ? {
                    ...x,
                    driveIngesting: false,
                    driveIngestDone: true,
                    // Dispatched runs don't have counts yet (they run in the
                    // Actions tab); in-process runs report real numbers.
                    driveDispatched: report.dispatched === true,
                    driveNotesWritten: report.notesWritten ?? 0,
                    driveFilesIngested: report.filesIngested ?? 0,
                  }
                : x,
            ),
          )
          if (report.dispatched) {
            setDriveNotice(
              'Drive ingestion started — it’s running as a background job (visible in your GitHub Actions tab). Notes will appear as it processes your files.',
            )
          }
        } catch (e) {
          setConnectors((prev) =>
            prev.map((x, i) => (i === idx ? { ...x, driveIngesting: false } : x)),
          )
          setDriveNotice(`Drive ingestion could not start: ${(e as Error).message}`)
        }
      })()
      return
    }

    // Chorale write flow (unchanged).
    setConnectors((prev) =>
      prev.map((x, i) =>
        i === idx
          ? {
              ...x,
              choraleFolderSelected: true,
              choraleWriteAccess: true,
              choraleFolderId: folder.id,
              choraleFolderName: folder.path || folder.name,
            }
          : x,
      ),
    )
    setDriveExplorerIdx(null)
  }

  const toggle = (idx: number) => {
    const c = connectors[idx]

    // Babelscribe: the button is an "Upload GDrive Audio Path" action, not a
    // connect/disconnect toggle. It opens the modal that collects the Drive
    // path and dispatches the transcription workflow. It never flips connected
    // state.
    if (c.key === 'browser-history') {
      setBabelscribeOpen(true)
      return
    }

    // Animatics: Connect opens the Phase 1 flow (starting/continuing a run);
    // Disconnect forgets the last run so the user can start fresh from step 1.
    if (c.icon === 'animatics') {
      if (animaticsConnected) {
        // Disconnect — wipe the run, then reset UI state.
        fetch('/api/animatics/reset', { method: 'POST' })
          .catch(() => {})
          .finally(() => {
            setAnimaticsConnected(false)
          })
        setConnectors((prev) =>
          prev.map((x, i) => (i === idx ? { ...x, connected: false } : x)),
        )
        persistConnectorState(c.key, { connected: false })
      } else {
        // Connect — open the flow to begin a new run.
        setAnimaticsOpen(true)
      }
      return
    }

    // WhatsApp: open the phone-number popup (connect) or disconnect the link.
    if (isWhatsApp(c)) {
      if (c.connected) {
        fetch('/api/whatsapp/disconnect', { method: 'POST' }).catch(() => {})
        setConnectors((prev) =>
          prev.map((x, i) => (i === idx ? { ...x, connected: false, connectedEmail: null, wa: null } : x)),
        )
        persistConnectorState(c.key, { connected: false })
        return
      }
      openWhatsApp()
      return
    }

    // Gmail cards use the real OAuth + read/parse backend.
    if (isGmail(c)) {
      if (c.connected) {
        // Disconnect: clear the server-side token, then reset the card.
        fetch('/api/gmail/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card: c.cardId }),
        }).catch(() => {})
        setConnectors((prev) =>
          prev.map((x, i) =>
            i === idx ? { ...x, connected: false, connectedEmail: null, scan: null, scanning: false, ingesting: false, ingestDone: false, ingestedCount: null } : x,
          ),
        )
        persistConnectorState(c.key, { connected: false })
        return
      }
      // Connect: hand off to Google. This navigates the browser to the
      // account chooser + consent screen; on return the app auto-scans.
      window.location.href = `/api/gmail/authorize?card=${c.cardId}`
      return
    }

    // Slack card uses the real Slack OAuth + 1-month read backend.
    if (isSlack(c)) {
      if (c.connected) {
        // Disconnect: clear the server-side token, then reset the card.
        fetch('/api/slack/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card: c.slackCardId }),
        }).catch(() => {})
        setConnectors((prev) =>
          prev.map((x, i) =>
            i === idx
              ? { ...x, connected: false, connectedEmail: null, slackScan: null, slackTeam: null, scanning: false }
              : x,
          ),
        )
        persistConnectorState(c.key, { connected: false })
        return
      }
      // Connect: hand off to Slack. On return the app auto-pulls the last month.
      window.location.href = `/api/slack/authorize?card=${c.slackCardId}`
      return
    }

    // Drive-ingest cards: real read-only OAuth + diff-based ingestion (Read Me).
    if (isDriveIngest(c)) {
      if (c.connected) {
        // Disconnect: drop the Drive token/session for the card, then reset.
        fetch('/api/drive/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card: c.key }),
        }).catch(() => {})
        setConnectors((prev) =>
          prev.map((x, i) =>
            i === idx
              ? {
                  ...x,
                  connected: false,
                  connectedEmail: null,
                  driveIngestFolder: null,
                  driveIngesting: false,
                  driveIngestDone: false,
                  driveNotesWritten: undefined,
                  driveFilesIngested: undefined,
                }
              : x,
          ),
        )
        persistConnectorState(c.key, { connected: false })
        return
      }
      // Connect: hand off to Google for read-only Drive consent. On return the
      // app opens the folder explorer, saves the ingestion root, and runs the
      // first-connection ingestion pass.
      window.location.href = `/api/drive/authorize?card=${encodeURIComponent(c.key)}`
      return
    }

    // Everything else (Calendar, Babelscribe) has no backend of its
    // own, so the toggle IS the persisted state. Flip locally, then save.
    const nextConnected = !c.connected
    setConnectors((prev) =>
      prev.map((x, i) => {
        if (i !== idx) return x
        if (x.connected) return { ...x, connected: false, connectedEmail: null }
        return { ...x, connected: true, connectedEmail: x.service ? 'alex.whitmore@gmail.com' : null }
      }),
    )
    persistConnectorState(c.key, { connected: nextConnected })
  }

  return (
    <>
    {notice && (
      <div className="gmail-notice" role="alert">
        <span>{notice}</span>
        <button className="gmail-notice-close" aria-label="Dismiss" onClick={clearNotice}>×</button>
      </div>
    )}
    {driveNotice && (
      <div className="gmail-notice" role="alert">
        <span>{driveNotice}</span>
        <button className="gmail-notice-close" aria-label="Dismiss" onClick={() => setDriveNotice(null)}>×</button>
      </div>
    )}
    <div id="connectors-grid">
      {connectors.map((c, idx) => {
        const gmail = isGmail(c)
        const whatsapp = isWhatsApp(c)
        const slack = isSlack(c)
        const animatics = c.icon === 'animatics'
        const babelscribe = c.key === 'browser-history'
        const chorale = c.key === 'chorale-recorder'
        let statusText: string
        if (whatsapp && c.wa) {
          if (c.wa.state === 'pairing') statusText = 'Pairing — enter code on phone'
          else if (c.wa.state === 'connected') statusText = 'Linked'
          else statusText = 'Not connected'
        } else if (slack && c.connected) {
          statusText = c.slackTeam ? `Connected · ${c.slackTeam}` : 'Connected'
        } else if (c.connected) {
          statusText = c.connectedEmail ? `Connected as ${c.connectedEmail}` : 'Connected'
        } else {
          statusText = 'Not connected'
        }
        if (babelscribe) {
          statusText = 'upload multi-lingual audio to translate and transcribe'
        }

        // Gmail ingestion overrides the desc + status: while the gmail-calibrate
        // job runs, both "Email ingestion for the vault." and "Not connected"
        // are replaced by a single in-progress line; once complete, the card
        // shows the real ingested-email count from the DB.
        let cardDesc: string = c.desc
        if (gmail && c.connected) {
          if (c.ingesting) {
            // Only the blue status pill shows the in-progress state — leave the
            // description line untouched to avoid repeating the same text.
            statusText = 'Ingestion is in-progress'
          } else if (c.ingestDone) {
            // The ingested-count line is shown once, in the summary block below;
            // the blue pill shows the connected account. Leave the description
            // line as-is so the text isn't repeated.
            statusText = c.connectedEmail ? `Connected as ${c.connectedEmail}` : 'Connected'
          }
        }

        // Buttons: Gmail scanning shows a disabled "Reading…" state.
        const btnLabel = babelscribe
          ? 'Upload GDrive Audio Path'
          : animatics
          ? animaticsConnected
            ? 'Disconnect'
            : 'Connect'
          : c.scanning
          ? 'Reading…'
          : whatsapp && c.wa?.state === 'pairing'
          ? 'Pairing…'
          : c.connected
          ? 'Disconnect'
          : 'Connect'

        // Gate the CONNECT action behind persisted settings: a box can only be
        // connected once its settings row exists in the DB for this user.
        // Disconnect is never gated (don't trap an already-connected box), and
        // the gear/settings button is always enabled so the user can create the
        // row first.
        const isConnectedNow = animatics ? animaticsConnected : c.connected
        // Babelscribe's Connect is always enabled — it has no settings to save first.
        const needsSettingsFirst = !babelscribe && !c.settingsPersisted && !isConnectedNow
        const connectDisabled = c.scanning || needsSettingsFirst

        return (
          <div className="connector-card" key={idx}>
            <div className="connector-top">
              {c.icon ? (
                <div className="connector-icon brand">{BRAND_ICONS[c.icon]}</div>
              ) : (
                <div className="connector-icon">{c.code}</div>
              )}
              <div className="connector-name">{c.name}</div>
            </div>
            {!babelscribe && !chorale && <div className="connector-desc">{cardDesc}</div>}

            {/* Gmail ingestion state (gmail-calibrate worker). The in-progress
                state is shown only by the blue status pill below; here we show
                the ingested count once the job completes. */}
            {gmail && c.connected && c.ingestDone && (
              <div className="gmail-scan-summary">
                <span>Total {(c.ingestedCount ?? 0).toLocaleString()} email{c.ingestedCount === 1 ? '' : 's'} ingested</span>
              </div>
            )}

            {/* Gmail read summary — small font, inbox + sent counts over the
                user-configured window (settings.backfillDays, default 30).
                Hidden once ingestion takes over the card. */}
            {gmail && c.connected && !c.ingesting && !c.ingestDone && (c.scanning || c.scan) && (
              <div className="gmail-scan-summary">
                {(() => {
                  const days = c.settings?.backfillDays ?? DEFAULT_CONNECTOR_SETTINGS.backfillDays
                  const windowLabel = `last ${days} day${days === 1 ? '' : 's'}`
                  if (c.scanning) {
                    return (
                      <span className="gmail-scan-loading">
                        Reading your {windowLabel} of mail…
                      </span>
                    )
                  }
                  if (c.scan) {
                    return (
                      <>
                        <span>
                          Inbox ({windowLabel}): {c.scan.inboxCount.toLocaleString()} emails
                        </span>
                        <span>
                          Sent ({windowLabel}): {c.scan.sentCount.toLocaleString()} emails
                        </span>
                      </>
                    )
                  }
                  return null
                })()}
              </div>
            )}

            {/* WhatsApp ingestion summary — captured + vectorized counts. */}
            {whatsapp && c.wa && (c.wa.state === 'connected' || (c.wa.totalMessages ?? 0) > 0) && (
              <div className="gmail-scan-summary">
                <span>
                  Captured: {(c.wa.totalMessages ?? 0).toLocaleString()} messages
                  {typeof c.wa.chats === 'number' ? ` · ${c.wa.chats} chats` : ''}
                </span>
                <span>Vectorized: {(c.wa.processedMessages ?? 0).toLocaleString()} messages</span>
              </div>
            )}

            {/* Slack read summary — last-month message + channel counts. */}
            {slack && c.connected && (c.scanning || c.slackScan) && (
              <div className="gmail-scan-summary">
                {c.scanning ? (
                  <span className="gmail-scan-loading">Pulling your last 1 month of Slack chats…</span>
                ) : c.slackScan ? (
                  <>
                    <span>
                      Last 30 days: {c.slackScan.totalMessages.toLocaleString()} messages
                      {` · ${c.slackScan.activeChannels} active channel${c.slackScan.activeChannels === 1 ? '' : 's'}`}
                    </span>
                    {c.slackScan.channels.length > 0 && (
                      <span>
                        Busiest: {c.slackScan.channels
                          .slice(0, 3)
                          .map((ch) =>
                            `${ch.type === 'im' ? 'DM' : ch.type === 'mpim' ? 'Group DM' : '#' + ch.name} (${ch.messageCount})`,
                          )
                          .join(', ')}
                      </span>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {needsSettingsFirst && !chorale && (
              <div className="connector-settings-hint" role="note">
                Configure settings (gear icon) and Save to enable Connect.
              </div>
            )}

            <div className="connector-bottom">
              {chorale ? (
                <div className="chorale-actions-wrap">
                  <div className="connector-actions chorale-actions">
                    <button
                      type="button"
                      className="connect-toggle"
                      onClick={() => configureChoraleDrive(idx)}
                    >
                      Configure GDrive
                    </button>
                    <button
                      type="button"
                      className="connect-toggle chorale-record"
                      onClick={() => openChoraleRecorder(idx)}
                      disabled={!(c.choraleFolderSelected && c.choraleWriteAccess)}
                      title={
                        c.choraleFolderSelected && c.choraleWriteAccess
                          ? 'Open the recorder to capture system/tab audio and save it to your Drive folder.'
                          : 'Configure a Google Drive folder with write access first'
                      }
                    >
                      Turn-on Recorder
                    </button>
                  </div>
                  {c.choraleFolderSelected && c.choraleWriteAccess && (
                    <div className="chorale-recorder-note" role="note">
                      Records your computer/tab audio and saves it to{' '}
                      <strong>{c.choraleFolderName ?? 'your folder'}</strong>. When you click record,
                      your browser asks which screen or tab to capture — pick the meeting tab and
                      enable “share audio” to record all participants.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {animatics ? (
                    <span className="connector-status off" style={{ visibility: 'hidden' }}></span>
                  ) : (
                    <span className={`connector-status ${c.connected ? 'connected' : 'off'}`}>{statusText}</span>
                  )}
                  <div className="connector-actions">
                    {!babelscribe && (
                      <button
                        type="button"
                        className="connector-settings"
                        aria-label={`${c.name} settings`}
                        title="Settings"
                        onClick={() => openConnectorSettings(idx)}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                      </button>
                    )}
                    <button
                      className={`connect-toggle ${!babelscribe && (animatics ? animaticsConnected : c.connected) ? 'connected' : ''}`}
                      onClick={() => toggle(idx)}
                      disabled={connectDisabled}
                      title={
                        needsSettingsFirst
                          ? 'Open settings (gear) and click “Save settings” to enable Connect'
                          : undefined
                      }
                    >
                      {btnLabel}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
    {animaticsOpen && (
      <AnimaticsFlow
        onClose={() => setAnimaticsOpen(false)}
        onConnectedChange={(v) => {
          setAnimaticsConnected(v)
          // Mirror the Animatics run existence into persisted connect state so
          // the grid card paints the right label on the next reload.
          persistConnectorState('animatics', { connected: v })
        }}
      />
    )}
    {babelscribeOpen && <BabelscribeModal onClose={() => setBabelscribeOpen(false)} />}
    {driveExplorerIdx !== null && connectors[driveExplorerIdx] && (
      <DriveExplorerModal
        card={connectors[driveExplorerIdx].key}
        connectedEmail={connectors[driveExplorerIdx].connectedEmail}
        onSelect={(folder) => onDriveFolderSelected(driveExplorerIdx, folder)}
        onClose={() => setDriveExplorerIdx(null)}
      />
    )}
    {choraleDriveUrlIdx !== null && connectors[choraleDriveUrlIdx] && (
      <ChoraleDriveUrlModal
        card={connectors[choraleDriveUrlIdx].key}
        currentFolderName={connectors[choraleDriveUrlIdx].choraleFolderName ?? null}
        onSaved={(folder) => onChoraleFolderSavedFromUrl(choraleDriveUrlIdx, folder)}
        onClose={() => setChoraleDriveUrlIdx(null)}
      />
    )}
    {choraleRecorderIdx !== null && connectors[choraleRecorderIdx] && (
      <ChoraleRecorderModal
        card={connectors[choraleRecorderIdx].key}
        folderName={connectors[choraleRecorderIdx].choraleFolderName ?? 'your Drive folder'}
        onClose={() => setChoraleRecorderIdx(null)}
      />
    )}
    {settingsIdx !== null && connectors[settingsIdx] && (
      <ConnectorSettingsModal
        connector={connectors[settingsIdx]}
        onClose={closeConnectorSettings}
        onConnectChange={(next) => {
          const key = connectors[settingsIdx].key
          persistConnectorState(key, { connected: next })
          setConnectors((prev) =>
            prev.map((x) =>
              x.key === key
                ? { ...x, connected: next, ...(next ? {} : { connectedEmail: null }) }
                : x,
            ),
          )
        }}
        onSettingsSaved={(settings) => {
          const key = connectors[settingsIdx].key
          setConnectors((prev) =>
            prev.map((x) =>
              // Saving writes a DB row → the grid Connect button becomes enabled
              // for this card without needing a reload.
              x.key === key ? { ...x, settings, settingsPersisted: true } : x,
            ),
          )
        }}
        onReadNow={(lastReadAt) => {
          const key = connectors[settingsIdx].key
          setConnectors((prev) => prev.map((x) => (x.key === key ? { ...x, lastReadAt } : x)))
        }}
      />
    )}
    </>
  )
}

/* ---------------- Connector settings modal ---------------- */

// Per-source destination text shown in the disconnect alert + disclaimer.
// Disconnecting a connector always happens at the source, not inside Entwin.
function sourceSettingsLabel(connector: Connector): string {
  switch (connector.service) {
    case 'gmail':
      return 'your Google Account permissions (myaccount.google.com → Security → Third-party access)'
    case 'drive':
      return 'your Google Account permissions (myaccount.google.com → Security → Third-party access)'
    case 'slack':
      return 'your Slack workspace settings (Apps → Manage → Entwin)'
    case 'whatsapp':
      return 'WhatsApp on your phone (Settings → Linked Devices)'
    default:
      break
  }
  switch (connector.icon) {
    case 'calendar':
      return 'your Google Account permissions (myaccount.google.com → Security → Third-party access)'
    default:
      break
  }
  if (connector.code === 'BH') {
    return 'your browser’s connected-apps settings'
  }
  return 'the source application’s connected-apps settings'
}

// Human-readable label for the account/source that a connection targets.
function sourceDisplayName(connector: Connector): string {
  if (connector.service === 'gmail' || connector.service === 'drive' || connector.icon === 'calendar') {
    return 'this Google account'
  }
  if (connector.service === 'slack') return 'this Slack workspace'
  if (connector.service === 'whatsapp') return 'this WhatsApp account'
  return 'this source'
}

// Small stepper input constrained to [min, max] integers.
function IntegerStepper({
  value,
  min,
  max,
  onChange,
  readOnly = false,
  suffix,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  onChange?: (n: number) => void
  readOnly?: boolean
  suffix?: string
  ariaLabel?: string
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const set = (n: number) => {
    if (readOnly || !onChange) return
    if (Number.isNaN(n)) return
    onChange(clamp(Math.trunc(n)))
  }
  return (
    <div className={`int-stepper ${readOnly ? 'ro' : ''}`}>
      <div className="int-stepper-field">
        {!readOnly && (
          <button
            type="button"
            className="int-stepper-btn"
            aria-label="Decrease"
            onClick={() => set(value - 1)}
            disabled={value <= min}
          >
            −
          </button>
        )}
        <input
          type="number"
          className="int-stepper-input"
          value={value}
          min={min}
          max={max}
          step={1}
          readOnly={readOnly}
          aria-label={ariaLabel}
          onChange={(e) => set(parseInt(e.target.value, 10))}
          onBlur={(e) => set(parseInt(e.target.value, 10))}
        />
        {!readOnly && (
          <button
            type="button"
            className="int-stepper-btn"
            aria-label="Increase"
            onClick={() => set(value + 1)}
            disabled={value >= max}
          >
            +
          </button>
        )}
      </div>
      {suffix && <span className="int-stepper-suffix">{suffix}</span>}
    </div>
  )
}

function ConnectorSettingsModal({
  connector,
  onClose,
  onConnectChange,
  onSettingsSaved,
  onReadNow,
}: {
  connector: Connector
  onClose: () => void
  // Persist + reflect a Connect/Disconnect made from inside the modal.
  onConnectChange: (connected: boolean) => void
  // Reflect saved settings back into the parent's connector list.
  onSettingsSaved: (settings: ConnectorSettings) => void
  // Reflect a successful on-demand read (last-read timestamp) back to the grid.
  onReadNow?: (lastReadAt: string) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const initiallyConnected =
    connector.service === 'whatsapp'
      ? connector.wa?.state === 'connected'
      : !!connector.connected

  // Uniform connect/disconnect state, local to the modal.
  const [connected, setConnected] = useState(initiallyConnected)
  const [checking, setChecking] = useState(false)
  const [showDisclaimer, setShowDisclaimer] = useState(false)
  const [connErr, setConnErr] = useState<string | null>(null)

  // Seed the steppers from this card's persisted per-user settings (falling
  // back to defaults for a card the user has never saved).
  const seed = connector.settings ?? DEFAULT_CONNECTOR_SETTINGS
  const [pollHours, setPollHours] = useState(seed.pollHours)
  const [backfillDays, setBackfillDays] = useState(seed.backfillDays)
  const [totalWindowDays, setTotalWindowDays] = useState(seed.totalWindowDays)
  const [saving, setSaving] = useState(false)

  // On-demand read state.
  const [lastReadAt, setLastReadAt] = useState<string | null>(connector.lastReadAt ?? null)
  const [reading, setReading] = useState(false)
  const [readErr, setReadErr] = useState<string | null>(null)

  const handleConnectToggle = async () => {
    setConnErr(null)
    if (connected) {
      // Real disconnect: revoke at source (Gmail/Slack token, WhatsApp link) and
      // stop future syncs. Backend-less cards just persist the toggle.
      setChecking(true)
      try {
        const res = await fetch('/api/connectors/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectorKey: connector.key }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || `Disconnect failed (${res.status})`)
        }
        setConnected(false)
        setShowDisclaimer(true)
        onConnectChange(false)
      } catch (e) {
        setConnErr((e as Error).message)
      } finally {
        setChecking(false)
      }
      return
    }
    // Connect: re-check whether access at the source is genuinely live. For a
    // backend-owned card this is the real session/link state; for a backend-less
    // card the persisted toggle is the only truth, so a click simply enables it.
    setChecking(true)
    try {
      const res = await fetch('/api/connectors/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorKey: connector.key }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `Status check failed (${res.status})`)
      if (d.backendOwned && !d.connected) {
        // The source revoked access (or was never linked). Don't fake a connect;
        // tell the user to reconnect at the source.
        setConnErr(
          `Entwin isn't linked to ${sourceDisplayName(connector)} anymore. Reconnect it from the ${connector.name} card on the Connectors grid.`,
        )
        setConnected(false)
        onConnectChange(false)
      } else {
        setConnected(true)
        setShowDisclaimer(false)
        onConnectChange(true)
      }
    } catch (e) {
      setConnErr((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  // "Read Now": trigger a real on-demand read (Gmail/Slack scan, WhatsApp sync)
  // for backend-owned cards, and record the read timestamp in every case.
  const handleReadNow = async () => {
    setReadErr(null)
    setReading(true)
    try {
      const res = await fetch('/api/connectors/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorKey: connector.key }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `Read failed (${res.status})`)
      if (d.lastReadAt) {
        setLastReadAt(d.lastReadAt)
        onReadNow?.(d.lastReadAt)
      }
      if (d.read && d.read.attempted && !d.read.ok) {
        setReadErr(d.read.detail || 'The read attempt reported a problem.')
      }
    } catch (e) {
      setReadErr((e as Error).message)
    } finally {
      setReading(false)
    }
  }

  // Persist this card's settings for the current user, then close.
  const handleSaveSettings = async () => {
    setSaving(true)
    const settings: ConnectorSettings = { pollHours, backfillDays, totalWindowDays }
    await persistConnectorState(connector.key, { settings })
    onSettingsSaved(settings)
    setSaving(false)
    onClose()
  }

  return (
    <div
      className="conn-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${connector.name} settings`}
      onClick={onClose}
    >
      <div className="conn-settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="conn-settings-head">
          <div className="conn-settings-title">
            {connector.icon ? (
              <span className="connector-icon brand">{BRAND_ICONS[connector.icon]}</span>
            ) : (
              <span className="connector-icon">{connector.code}</span>
            )}
            <span>{connector.name}</span>
          </div>
          <button className="conn-settings-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="conn-settings-body">
          {/* Connection status + connect/disconnect */}
          <div className="conn-status-bar">
            <span className={`conn-status-text ${connected ? 'ok' : 'muted'}`}>
              {connected ? 'Connected' : 'Not connected'}
            </span>
            <button
              type="button"
              className={`conn-status-btn ${connected ? 'connected' : ''}`}
              onClick={handleConnectToggle}
              disabled={checking}
            >
              {checking ? 'Checking…' : connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>

          {connErr && (
            <div className="conn-disclaimer" role="alert" style={{ color: '#c62828' }}>
              {connErr}
            </div>
          )}

          {showDisclaimer && !connected && (
            <div className="conn-disclaimer" role="note">
              Entwin has stopped reading from {sourceDisplayName(connector)} on your device. To fully revoke access,
              remove Entwin from {sourceSettingsLabel(connector)}.
            </div>
          )}

          {/* On-demand check */}
          <div className="conn-field-card">
            <div className="conn-field-main">
              <div className="conn-field-title">On-demand check</div>
              <div className="conn-field-sub">
                Last read: {timeAgo(lastReadAt)}
                {readErr && <span style={{ color: '#c62828' }}> · {readErr}</span>}
              </div>
            </div>
            <button
              type="button"
              className="conn-secondary-btn"
              onClick={handleReadNow}
              disabled={reading}
            >
              {reading ? 'Reading…' : 'Read Now'}
            </button>
          </div>

          {/* Reading frequency */}
          <div className="conn-field-group">
            <div className="conn-field-heading">Reading frequency</div>
            <div className="conn-field-desc">How often Entwin polls this connector for changes, in hours.</div>
            <div className="conn-field-inline">
              <span className="conn-field-label">Poll every</span>
              <IntegerStepper
                value={pollHours}
                min={1}
                max={24}
                onChange={setPollHours}
                suffix="hours"
                ariaLabel="Poll frequency in hours"
              />
            </div>
          </div>

          {/* Ingestion window */}
          <div className="conn-field-group">
            <div className="conn-field-heading">Ingestion window</div>
            <div className="conn-field-desc">
              Controls how far back this {sourceDisplayName(connector)} is read. The initial ingestion is a one-time
              backfill; the total ingestion window is the rolling range Entwin keeps indexed going forward — anything
              older is pruned on the next sync. The window can&apos;t be shorter than the initial backfill.
            </div>
            <div className="conn-field-inline">
              <span className="conn-field-label">Initial ingestion (one-time backfill)</span>
              <IntegerStepper
                value={backfillDays}
                min={1}
                max={100}
                onChange={(v) => {
                  setBackfillDays(v)
                  // The rolling window can't be shorter than the backfill.
                  setTotalWindowDays((w) => (w < v ? v : w))
                }}
                suffix="days"
                ariaLabel="Initial ingestion backfill in days"
              />
            </div>
            <div className="conn-field-inline">
              <span className="conn-field-label">Total ingestion window</span>
              <IntegerStepper
                value={totalWindowDays}
                min={Math.max(30, backfillDays)}
                max={3650}
                onChange={setTotalWindowDays}
                suffix="days"
                ariaLabel="Total ingestion window in days"
              />
            </div>
          </div>
        </div>

        <div className="conn-settings-foot">
          <button className="conn-foot-btn ghost" onClick={onClose} disabled={saving}>Close</button>
          <button className="conn-foot-btn primary" onClick={handleSaveSettings} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Dashboard view ---------------- */

function KanbanPanel() {
  const [senders, setSenders] = useState<Sender[]>([])
  const [loading, setLoading] = useState(true)
  const [moveNote, setMoveNote] = useState('')
  const draggedId = useRef<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/senders')
      const data = await res.json().catch(() => ({ senders: [] }))
      const rows: Sender[] = (data.senders || []).map((s: any) => ({
        id: s.id,
        name: s.address,
        email: s.address,
        list: s.list as ListKey,
        isNew: s.isNew,
      }))
      setSenders(rows)
    } catch {
      setSenders([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const anyUnconfirmed = senders.some((s) => s.isNew)

  const drop = async (listKey: ListKey) => {
    const id = draggedId.current
    draggedId.current = null
    if (!id) return
    const sender = senders.find((s) => s.id === id)
    if (!sender || sender.list === listKey) return
    const ruleKey = `${sender.list}>${listKey}`
    if (MOVE_RULES[ruleKey]) setMoveNote(`${sender.name}: ${MOVE_RULES[ruleKey]}`)
    // optimistic move + confirm; a manual move confirms the sender
    setSenders((prev) => prev.map((s) => (s.id === id ? { ...s, list: listKey, isNew: false } : s)))
    try {
      await fetch('/api/senders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, list: listKey }),
      })
    } catch { /* non-fatal; refetch on next load */ }
  }

  const confirmAll = async () => {
    setSenders((prev) => prev.map((s) => ({ ...s, isNew: false })))
    try {
      await fetch('/api/senders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmAll: true }),
      })
      // Confirming the sender lists also releases the full-history ingest for any
      // Gmail account still in the onboarding calibration handshake.
      await fetch('/api/gmail/confirm-onboarding', { method: 'POST' }).catch(() => {})
    } catch { /* non-fatal */ }
  }

  return (
    <div className="dash-panel active" id="dash-kanban">
      {anyUnconfirmed && (
        <div className="kanban-banner" id="kanban-banner">
          <div className="kanban-banner-text">New and provisionally-sorted senders are highlighted. Drag any miscategorized sender to the right column, then confirm.</div>
          <button className="kanban-confirm-btn" onClick={confirmAll}>Confirm classification</button>
        </div>
      )}
      {loading ? (
        <div className="entity-empty">Loading senders…</div>
      ) : senders.length === 0 ? (
        <div className="entity-empty">No senders classified yet. They appear here as email is ingested.</div>
      ) : (
      <div className="kanban-board" id="kanban-board">
        {(['marketing', 'updates', 'people'] as ListKey[]).map((listKey) => {
          const cards = senders.filter((s) => s.list === listKey)
          return (
            <div
              className="kanban-column"
              key={listKey}
              onDragOver={(e) => {
                e.preventDefault()
                e.currentTarget.classList.add('drag-over')
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
              onDrop={(e) => {
                e.currentTarget.classList.remove('drag-over')
                drop(listKey)
              }}
            >
              <div className="kanban-column-header">
                <span>{LIST_LABELS[listKey]}</span>
                <span className="kanban-column-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.map((s) => (
                  <div
                    className={`kanban-card${s.isNew ? ' is-new' : ''}`}
                    key={s.id}
                    draggable
                    onDragStart={(e) => {
                      draggedId.current = s.id
                      e.currentTarget.classList.add('dragging')
                    }}
                    onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
                  >
                    <div className="kanban-card-name">{s.name}</div>
                    {s.isNew && <div className="kanban-card-new-tag">New</div>}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      )}
      <div className={`kanban-move-note${moveNote ? ' show' : ''}`} id="kanban-move-note">{moveNote}</div>
    </div>
  )
}

interface WAEntity {
  identityKey: string
  type: 'person' | 'group' | 'community'
  name: string
  tier: 'updates' | 'important'
  isNew: boolean
  reason: string | null
  isAdmin: boolean | null
  muted: boolean | null
  memberCount: number | null
  isCommunitySubgroup: boolean
}

const WA_TIER_LABELS: Record<'updates' | 'important', string> = {
  updates: 'Updates',
  important: 'Important WhatsApp Entities',
}

// Move-effect notes shown when an entity is dragged (Read Me §8, two-bucket form).
const WA_MOVE_RULES: Record<string, string> = {
  'updates>important':
    'Backfill: a full facet-split Memory Note will be created for every past day this entity was in Updates, dated to each day\u2019s original messages. This can take a while for a large or long-lived group.',
  'important>updates':
    'No deletion. Existing Memory Notes stand untouched. New days from this entity will log into the WhatsApp Updates Note instead (one-line gist).',
}

// The two-column WhatsApp Kanban (Read Me §7). Archived entities are the Ignore
// tier and never appear here. Given community-subgroup volume, the board has a
// search field and each column scrolls, unlike the shorter email board.
function WhatsAppKanbanPanel() {
  const [items, setItems] = useState<WAEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [moveNote, setMoveNote] = useState('')
  const draggedKey = useRef<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/whatsapp/entities')
      const data = await res.json().catch(() => ({ updates: [], important: [] }))
      const merged: WAEntity[] = [...(data.updates || []), ...(data.important || [])]
      setItems(merged)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const anyUnconfirmed = items.some((i) => i.isNew)

  const drop = async (tier: 'updates' | 'important') => {
    const key = draggedKey.current
    draggedKey.current = null
    if (!key) return
    const ent = items.find((i) => i.identityKey === key)
    if (!ent || ent.tier === tier) return
    const ruleKey = `${ent.tier}>${tier}`
    if (WA_MOVE_RULES[ruleKey]) setMoveNote(`${ent.name}: ${WA_MOVE_RULES[ruleKey]}`)
    // optimistic move + confirm
    setItems((prev) => prev.map((i) => (i.identityKey === key ? { ...i, tier, isNew: false } : i)))
    try {
      await fetch('/api/whatsapp/entities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityKey: key, tier }),
      })
    } catch { /* non-fatal; refetch on next load */ }
  }

  const confirmAll = async () => {
    setItems((prev) => prev.map((i) => ({ ...i, isNew: false })))
    try {
      await fetch('/api/whatsapp/entities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmAll: true }),
      })
    } catch { /* non-fatal */ }
  }

  const q = query.trim().toLowerCase()
  const visible = q
    ? items.filter((i) => i.name.toLowerCase().includes(q) || i.identityKey.toLowerCase().includes(q))
    : items

  return (
    <div className="dash-panel active" id="dash-wa-kanban">
      {anyUnconfirmed && (
        <div className="kanban-banner" id="wa-kanban-banner">
          <div className="kanban-banner-text">New and provisionally-sorted WhatsApp entities are highlighted. Drag any miscategorized entity to the right column, then confirm. Moving a group from Updates to Important re-expands its past days into full notes.</div>
          <button className="kanban-confirm-btn" onClick={confirmAll}>Confirm classification</button>
        </div>
      )}
      <div className="kanban-search-row">
        <input
          className="kanban-search"
          type="text"
          placeholder="Search WhatsApp entities..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {loading ? (
        <div className="entity-empty">Loading WhatsApp entities...</div>
      ) : items.length === 0 ? (
        <div className="entity-empty">No WhatsApp entities classified yet. They appear here as WhatsApp is ingested. Archived chats are never shown.</div>
      ) : (
      <div className="kanban-board kanban-board-two" id="wa-kanban-board">
        {(['updates', 'important'] as ('updates' | 'important')[]).map((tier) => {
          const cards = visible.filter((i) => i.tier === tier)
          return (
            <div
              className="kanban-column kanban-column-scroll"
              key={tier}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over') }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
              onDrop={(e) => { e.currentTarget.classList.remove('drag-over'); drop(tier) }}
            >
              <div className="kanban-column-header">
                <span>{WA_TIER_LABELS[tier]}</span>
                <span className="kanban-column-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.map((i) => (
                  <div
                    className={`kanban-card${i.isNew ? ' is-new' : ''}`}
                    key={i.identityKey}
                    draggable
                    onDragStart={(e) => { draggedKey.current = i.identityKey; e.currentTarget.classList.add('dragging') }}
                    onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
                  >
                    <div className="kanban-card-name">{i.name}</div>
                    <div className="kanban-card-meta">
                      <span className="kanban-tag">{i.type}</span>
                      {i.isAdmin ? <span className="kanban-tag">admin</span> : null}
                      {i.muted ? <span className="kanban-tag">muted</span> : null}
                      {typeof i.memberCount === 'number' ? <span className="kanban-tag">{i.memberCount} members</span> : null}
                      {i.isCommunitySubgroup ? <span className="kanban-tag">community</span> : null}
                    </div>
                    {i.isNew && <div className="kanban-card-new-tag">New</div>}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      )}
      <div className={`kanban-move-note${moveNote ? ' show' : ''}`} id="wa-kanban-move-note">{moveNote}</div>
    </div>
  )
}

interface PendingEntity { id: string; name: string; aliases: string[]; candidateId: string | null; candidateName: string | null; score: number | null; references: number; newPhone?: string | null; prevPhone?: string | null; isNumberChange?: boolean }
interface SearchEntity { id: string; name: string; aliases: string[]; type?: string }

function EntitiesPanel({ entities, setEntities }: { entities: Entity[]; setEntities: React.Dispatch<React.SetStateAction<Entity[]>> }) {
  void entities; void setEntities // legacy props unused — panel owns its data now
  const [pending, setPending] = useState<PendingEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const loadPending = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/entities/review')
      const data = await res.json().catch(() => ({ pending: [] }))
      setPending(data.pending || [])
    } catch {
      setPending([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadPending() }, [])

  const act = async (url: string, body: object, id: string) => {
    setBusy(id)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) setPending((p) => p.filter((e) => e.id !== id))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="dash-panel active" id="dash-entities">
      {/* ---- Pending Review ---- */}
      <div className="section-heading">Pending review</div>
      <div id="entity-queue">
        {loading ? (
          <div className="entity-empty">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="entity-empty">No entities waiting for review.</div>
        ) : (
          pending.map((ent) => (
            <div className="entity-card-v1" key={ent.id}>
              <div className="entity-card-v1-top">
                <span className="entity-card-v1-name">{ent.name}</span>
                {ent.candidateName && (
                  <span className="entity-card-v1-score">
                    {ent.score != null ? `match ${ent.score}%` : 'possible match'} &rarr; {ent.candidateName}
                  </span>
                )}
              </div>
              <div className="entity-card-v1-meta">{ent.references} reference{ent.references === 1 ? '' : 's'}</div>
              {ent.isNumberChange && (
                <div className="entity-card-v1-numberchange">
                  Possible WhatsApp number change: <code>{ent.prevPhone}</code> &rarr; <code>{ent.newPhone}</code>
                </div>
              )}
              {ent.aliases.length > 0 && <div className="entity-card-v1-aliases">Aliases seen: {ent.aliases.join(', ')}</div>}
              <div className="entity-card-v1-actions">
                {ent.candidateId && (
                  <button
                    className="entity-card-v1-btn approve"
                    disabled={busy === ent.id}
                    onClick={() => act('/api/entities/merge', { sourceId: ent.id, targetId: ent.candidateId }, ent.id)}
                  >
                    {ent.isNumberChange ? 'Confirm same person' : `Merge into ${ent.candidateName}`}
                  </button>
                )}
                <button
                  className="entity-card-v1-btn reject"
                  disabled={busy === ent.id}
                  onClick={() => act('/api/entities/reject', { entityId: ent.id }, ent.id)}
                >
                  Keep as distinct
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ---- New Review: manual merge + alias split ---- */}
      <NewReviewPanel onChanged={loadPending} />
    </div>
  )
}

// New Review (v5 §4): user-initiated. Search all entities and merge any two;
// click into an entity to split specific aliases out into a new entity.
function NewReviewPanel({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchEntity[]>([])
  const [selected, setSelected] = useState<SearchEntity | null>(null)
  const [mergeTarget, setMergeTarget] = useState<SearchEntity | null>(null)
  const [checkedAliases, setCheckedAliases] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const search = async (term: string) => {
    try {
      const res = await fetch(`/api/entities/search?q=${encodeURIComponent(term)}`)
      const data = await res.json().catch(() => ({ entities: [] }))
      setResults(data.entities || [])
    } catch {
      setResults([])
    }
  }
  useEffect(() => {
    const t = setTimeout(() => search(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const pick = (e: SearchEntity) => {
    setSelected(e)
    setCheckedAliases(new Set())
    setMergeTarget(null)
    setMsg('')
  }

  const doMerge = async () => {
    if (!selected || !mergeTarget || selected.id === mergeTarget.id) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/entities/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: selected.id, targetId: mergeTarget.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) { setMsg(`Merged "${selected.name}" into "${mergeTarget.name}".`); setSelected(null); search(q); onChanged() }
      else setMsg(d.error || 'Merge failed')
    } finally { setBusy(false) }
  }

  const doSplit = async () => {
    if (!selected || checkedAliases.size === 0) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/entities/split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId: selected.id, aliases: [...checkedAliases] }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) { setMsg(`Split ${checkedAliases.size} alias(es) into a new entity.`); setSelected(null); search(q); onChanged() }
      else setMsg(d.error || 'Split failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="new-review">
      <div className="section-heading" style={{ marginTop: 28 }}>New review — merge or split</div>
      <input
        className="entity-search"
        placeholder="Search entities by name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="entity-search-results">
        {results.map((e) => (
          <button
            key={e.id}
            className={`entity-result${selected?.id === e.id ? ' selected' : ''}`}
            onClick={() => pick(e)}
          >
            <span className="entity-result-name">{e.name}</span>
            <span className="entity-result-alias-count">{e.aliases.length} alias{e.aliases.length === 1 ? '' : 'es'}</span>
          </button>
        ))}
        {q && results.length === 0 && <div className="entity-empty">No matches.</div>}
      </div>

      {selected && (
        <div className="entity-detail">
          <div className="entity-detail-title">{selected.name}</div>

          {/* Merge: pick a target */}
          <div className="entity-detail-sub">Merge into another entity</div>
          <div className="entity-search-results compact">
            {results.filter((e) => e.id !== selected.id).map((e) => (
              <button
                key={e.id}
                className={`entity-result${mergeTarget?.id === e.id ? ' selected' : ''}`}
                onClick={() => setMergeTarget(e)}
              >
                <span className="entity-result-name">{e.name}</span>
              </button>
            ))}
          </div>
          <button className="entity-card-v1-btn approve" disabled={!mergeTarget || busy} onClick={doMerge}>
            {mergeTarget ? `Merge "${selected.name}" → "${mergeTarget.name}"` : 'Pick a target above'}
          </button>

          {/* Split: check aliases to carve out */}
          {selected.aliases.length > 1 && (
            <>
              <div className="entity-detail-sub" style={{ marginTop: 16 }}>Split aliases into a new entity</div>
              <div className="entity-alias-list">
                {selected.aliases.map((a) => (
                  <label key={a} className="entity-alias-item">
                    <input
                      type="checkbox"
                      checked={checkedAliases.has(a)}
                      onChange={(e) => {
                        setCheckedAliases((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(a); else next.delete(a)
                          return next
                        })
                      }}
                    />
                    <span>{a}</span>
                  </label>
                ))}
              </div>
              <button className="entity-card-v1-btn" disabled={checkedAliases.size === 0 || busy} onClick={doSplit}>
                Split {checkedAliases.size > 0 ? `${checkedAliases.size} ` : ''}alias(es) out
              </button>
            </>
          )}
        </div>
      )}
      {msg && <div className="new-review-msg">{msg}</div>}
    </div>
  )
}

interface Usage {
  inputTokens: number
  outputTokens: number
  calls: number
  byKind: Record<string, { calls: number; input: number; output: number }>
  notesIndexed?: number | null
  preferencesLearned?: number | null
  ingestion7d?: { ignore: number | null; storage: number | null; memoryWorthy: number | null }
  entitiesThisWeek?: number | null
}

// Two-entity display for a Memory Note (v5 §7). Shows, per resolved reference,
// the entity resolved AT INGESTION vs the entity that owns it NOW. They agree in
// the ordinary case; a divergence is the visible trace of a later merge/split,
// surfaced (in amber) rather than hidden. Reusable wherever a note is rendered;
// reads /api/notes/[id]/entities (the note_ownership index, never the frozen note).
function NoteEntities({ noteId }: { noteId: string }) {
  const [refs, setRefs] = useState<
    { matchedAlias: string | null; resolved: { id: string; name: string | null }; current: { id: string; name: string | null }; diverged: boolean }[]
  >([])
  useEffect(() => {
    let cancelled = false
    fetch(`/api/notes/${noteId}/entities`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setRefs(d.references || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [noteId])

  if (refs.length === 0) return null
  return (
    <div className="note-entities">
      {refs.map((r, i) => (
        <div className="note-entity-row" key={i}>
          <span className="note-entity-label">Resolved:</span>
          <span>{r.resolved.name || '—'}</span>
          {r.diverged && (
            <>
              <span className="note-entity-label">Current:</span>
              <span className="note-entity-diverged">{r.current.name || '—'}</span>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function OverviewPanel({ connectedCount, total, alertVisible, dismissAlert }: { connectedCount: number; total: number; alertVisible: boolean; dismissAlert: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [usageErr, setUsageErr] = useState('')

  useEffect(() => {
    const load = () => {
      fetch('/api/usage')
        .then((r) => r.json())
        .then((d) => { if (d.error) setUsageErr(d.error); else setUsage(d) })
        .catch((e) => setUsageErr(String(e)))
    }
    load()
    // refresh periodically so counts climb while a backfill runs
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  const fmt = (n: number) => n.toLocaleString()

  return (
    <div className="dash-panel active" id="dash-overview">
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card live">
          <div className="stat-value" id="sources-connected-value">{connectedCount} / {total}</div>
          <div className="stat-label">Sources connected</div>
          <div className="stat-sub">Live from Connectors.</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{usage && usage.notesIndexed != null ? fmt(usage.notesIndexed) : '—'}</div>
          <div className="stat-label">Notes indexed</div>
          <div className="stat-sub">Memory Notes written from your sources.</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{usage && usage.preferencesLearned != null ? fmt(usage.preferencesLearned) : '—'}</div>
          <div className="stat-label">Preferences learned</div>
          <div className="stat-sub">People &amp; organizations your twin recognizes.</div>
        </div>
      </div>

      {alertVisible && (
        <div className="alert-card" id="deleted-alert-card">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <div>
            <div className="alert-title">1 Memory Note&apos;s source email was deleted</div>
            <div className="alert-desc">A message that produced a Memory Note was later removed from the mailbox. The note itself is untouched, but worth a look since this is flagged directly rather than left in a log.</div>
            <button className="alert-link" onClick={dismissAlert}>Mark as reviewed</button>
          </div>
        </div>
      )}

      <div className="section-heading">Ingestion volume, last 7 days</div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Ignore tier</div>
          <div className="stat-value">{usage && usage.ingestion7d?.ignore != null ? fmt(usage.ingestion7d.ignore) : '—'}</div>
          <div className="stat-sub">Marketing list senders, logged to the Ignored Daily Note</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Storage tier</div>
          <div className="stat-value">{usage && usage.ingestion7d?.storage != null ? fmt(usage.ingestion7d.storage) : '—'}</div>
          <div className="stat-sub">Updates list senders (banks, social, transactions)</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Memory-worthy</div>
          <div className="stat-value">{usage && usage.ingestion7d?.memoryWorthy != null ? fmt(usage.ingestion7d.memoryWorthy) : '—'}</div>
          <div className="stat-sub">People list senders, full Memory Notes written</div>
        </div>
      </div>

      <div className="section-heading">Token usage {usage ? `(${fmt(usage.calls)} LLM calls)` : ''}</div>
      {usageErr && <div className="stat-sub" style={{ color: '#e53935' }}>Couldn’t load usage: {usageErr}</div>}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Input Tokens</div>
          <div className="stat-value">{usage ? fmt(usage.inputTokens) : '—'}</div>
          <div className="stat-breakdown">
            {usage && Object.entries(usage.byKind).map(([k, v]) => (
              <div className="stat-breakdown-row" key={k}><span>{k}</span><span>{fmt(v.input)}</span></div>
            ))}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Output Tokens</div>
          <div className="stat-value">{usage ? fmt(usage.outputTokens) : '—'}</div>
          <div className="stat-breakdown">
            {usage && Object.entries(usage.byKind).map(([k, v]) => (
              <div className="stat-breakdown-row" key={k}><span>{k}</span><span>{fmt(v.output)}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="section-heading">Entity growth, this week</div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">New entity files</div>
          <div className="stat-value">{usage && usage.entitiesThisWeek != null ? fmt(usage.entitiesThisWeek) : '—'}</div>
          <div className="stat-sub">Canonical entities created in the last 7 days</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total entities</div>
          <div className="stat-value">{usage && usage.preferencesLearned != null ? fmt(usage.preferencesLearned) : '—'}</div>
          <div className="stat-sub">All people &amp; organizations your twin knows</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Notes indexed</div>
          <div className="stat-value">{usage && usage.notesIndexed != null ? fmt(usage.notesIndexed) : '—'}</div>
          <div className="stat-sub">Total Memory Notes across all sources</div>
        </div>
      </div>
    </div>
  )
}

function DashboardView({ connectedCount, total, entities, setEntities }: { connectedCount: number; total: number; entities: Entity[]; setEntities: React.Dispatch<React.SetStateAction<Entity[]>> }) {
  const [tab, setTab] = useState<DashTab>('overview')
  const [alertVisible, setAlertVisible] = useState(true)
  const [pendingCount, setPendingCount] = useState(0)

  // Real pending-review count for the subtab badge.
  useEffect(() => {
    let cancelled = false
    fetch('/api/entities/review')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPendingCount((d.pending || []).length) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tab])

  return (
    <>
      <div className="view-header">Dashboard<div className="sub">Ingestion stats, sender classification, and entity review</div></div>
      <div className="subtab-bar">
        <button className={`subtab-btn${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`subtab-btn${tab === 'kanban' ? ' active' : ''}`} onClick={() => setTab('kanban')}>Sender Kanban</button>
        <button className={`subtab-btn${tab === 'wa-kanban' ? ' active' : ''}`} onClick={() => setTab('wa-kanban')}>WhatsApp Kanban</button>
        <button className={`subtab-btn${tab === 'entities' ? ' active' : ''}`} onClick={() => setTab('entities')}>
          Entity Review{pendingCount > 0 && <span className="subtab-badge" id="entity-badge">{pendingCount}</span>}
        </button>
      </div>
      <div id="dashboard-body">
        {tab === 'overview' && <OverviewPanel connectedCount={connectedCount} total={total} alertVisible={alertVisible} dismissAlert={() => setAlertVisible(false)} />}
        {tab === 'kanban' && <KanbanPanel />}
        {tab === 'wa-kanban' && <WhatsAppKanbanPanel />}
        {tab === 'entities' && <EntitiesPanel entities={entities} setEntities={setEntities} />}
      </div>
    </>
  )
}

/* ---------------- Memory view ---------------- */

interface GraphNode { id: string; name: string; type: string; size: number; firstSeen?: string; lastSeen?: string }
interface GraphEdge { source: string; target: string; weight: number }
interface WikiSource { n: number; url: string | null; date: string | null; urgency: string | null; channel?: string | null; similarity: number }
interface WikiState { answer: string; sources: WikiSource[]; loading: boolean }

// A WhatsApp contact with no saved / push name falls back to its raw phone
// number as the entity name (a bare digit string like "+59549805449252").
// Rendered verbatim that reads as a malformed number. This groups the digits
// into a clean, readable form (e.g. "+595 4980 5449 252") without asserting a
// country code we don't actually know. Non-phone names pass through untouched.
function displayEntityName(name: string): string {
  const raw = (name || '').trim()
  const m = raw.match(/^\+?(\d{7,15})$/)
  if (!m) return raw
  const digits = m[1]
  // Group as: country hint (leading 1-3 digits) then 3-4 digit blocks.
  const groups: string[] = []
  let rest = digits
  // First block: up to 3 digits as a loose country-code hint.
  const head = rest.slice(0, rest.length > 10 ? 3 : rest.length > 7 ? 2 : 1)
  groups.push(head)
  rest = rest.slice(head.length)
  while (rest.length > 0) {
    const take = rest.length > 4 ? 4 : rest.length
    groups.push(rest.slice(0, take))
    rest = rest.slice(take)
  }
  return `+${groups.join(' ')}`
}

function RebuildGraphButton() {
  const [state, setState] = useState<'idle' | 'queuing' | 'queued' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  const rebuild = async () => {
    if (state === 'queuing') return
    setState('queuing')
    setMsg('')
    try {
      const res = await fetch('/api/graph/rebuild', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `failed (${res.status})`)
      setState('queued')
      setMsg('Rebuilding… this runs in the background and takes a minute or two. Refresh the graph shortly.')
      setTimeout(() => setState('idle'), 8000)
    } catch (e) {
      setState('error')
      setMsg((e as Error).message)
    }
  }

  return (
    <div style={{ textAlign: 'right', minWidth: 140 }}>
      <button
        className="save-btn"
        onClick={rebuild}
        disabled={state === 'queuing'}
        style={{ whiteSpace: 'nowrap' }}
      >
        {state === 'queuing' ? 'Starting…' : 'Rebuild graph'}
      </button>
      {msg && (
        <div style={{ fontSize: 11, marginTop: 6, maxWidth: 220, color: state === 'error' ? '#e53935' : 'var(--muted, #888)' }}>
          {msg}
        </div>
      )}
    </div>
  )
}

// Human label for a source channel, used when the note has no web permalink
// (WhatsApp notes never do — see the wiki RAG / worker notes).
function channelLabel(channel?: string | null): string | null {
  if (!channel) return null
  const c = channel.toLowerCase()
  if (c === 'whatsapp') return 'WhatsApp'
  if (c === 'slack') return 'Slack'
  if (c === 'email' || c === 'gmail') return 'Email'
  return channel
}

function refLabel(s: WikiSource): string {
  const parts: string[] = []
  if (s.date) {
    const d = new Date(s.date)
    parts.push(isNaN(d.getTime()) ? String(s.date) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
  }
  if (s.url) {
    // Web-addressable source (e.g. Gmail permalink): show the hostname.
    try { parts.push(new URL(s.url).hostname.replace(/^www\./, '')) } catch { /* ignore */ }
  } else {
    // No permalink (WhatsApp, and any other non-web note): show the channel
    // name instead of a dead link so the chip still reads sensibly.
    const cl = channelLabel(s.channel)
    if (cl) parts.push(cl)
  }
  if (parts.length === 0) parts.push('Memory note')
  return parts.join(' · ')
}

// Strip light markdown to plain, readable text (headings, bold, italics,
// bullets, code fences, links) while keeping [n] citation markers intact.
function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim()) // code fences
    .replace(/`([^`]+)`/g, '$1')                                     // inline code
    .replace(/^#{1,6}\s+/gm, '')                                     // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')                               // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')                         // italics
    .replace(/^\s*[-*+]\s+/gm, '• ')                                 // bullets
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')           // md links
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// Renders answer as readable paragraphs; converts inline [n] into links that
// open the matching reference in a new tab (or jump to it if it has no URL).
function WikiAnswer({ answer, sources }: { answer: string; sources: WikiSource[] }) {
  const clean = stripMarkup(answer)
  const byN = Object.fromEntries(sources.map((s) => [s.n, s]))
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)

  const renderWithCitations = (line: string, keyBase: string) => {
    const out: React.ReactNode[] = []
    const re = /\[(\d+)\]/g
    let last = 0
    let m: RegExpExecArray | null
    let i = 0
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push(line.slice(last, m.index))
      const n = Number(m[1])
      const src = byN[n]
      if (src?.url) {
        out.push(
          <a key={`${keyBase}-c${i}`} className="memory-cite" href={src.url} target="_blank" rel="noopener noreferrer" title={refLabel(src)}>[{n}]</a>
        )
      } else {
        out.push(<sup key={`${keyBase}-c${i}`} className="memory-cite memory-cite-plain">[{n}]</sup>)
      }
      last = m.index + m[0].length
      i++
    }
    if (last < line.length) out.push(line.slice(last))
    return out
  }

  if (!clean) return <span className="memory-panel-loading">Nothing recorded yet.</span>

  return (
    <>
      {paragraphs.map((p, pi) => {
        const lines = p.split(/\n/).filter(Boolean)
        const isList = lines.every((l) => l.startsWith('• '))
        if (isList) {
          return (
            <ul className="memory-answer-list" key={pi}>
              {lines.map((l, li) => <li key={li}>{renderWithCitations(l.replace(/^•\s+/, ''), `${pi}-${li}`)}</li>)}
            </ul>
          )
        }
        return <p className="memory-answer-p" key={pi}>{renderWithCitations(p.replace(/\n/g, ' '), String(pi))}</p>
      })}
    </>
  )
}

function MemoryGraph() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ width: 500, height: 400 })
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [wiki, setWiki] = useState<WikiState | null>(null)

  // Pan/zoom viewport state.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const measure = () => {
      const rect = containerRef.current!.getBoundingClientRect()
      setDims({ width: rect.width || 500, height: rect.height || 400 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    fetch('/api/graph')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setErr(d.error); return }
        setNodes(d.nodes || [])
        setEdges(d.edges || [])
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const { width, height } = dims

  // Simple deterministic circular layout, largest bubbles toward the centre.
  const sorted = [...nodes].sort((a, b) => b.size - a.size)
  const positioned = sorted.map((n, i) => {
    if (i === 0 && sorted.length > 1) {
      return { ...n, x: width / 2, y: height / 2 }
    }
    const ring = i === 0 ? 0 : 1 + Math.floor((i - 1) / 8)
    const inRing = i === 0 ? 0 : (i - 1) % 8
    const radius = ring * Math.min(width, height) * 0.16
    const angle = (inRing / 8) * Math.PI * 2 + ring
    return { ...n, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius }
  })
  const byId = Object.fromEntries(positioned.map((n) => [n.id, n]))

  // ---- Bubble size by weight (mention count), on a sqrt scale so area, not
  // radius, tracks weight — big hubs don't swamp everything else.
  const sizes = nodes.map((n) => n.size)
  const minSize = Math.min(1, ...sizes)
  const maxSize = Math.max(1, ...sizes)
  const radiusFor = (size: number) => {
    if (maxSize <= minSize) return 14
    const t = (Math.sqrt(size) - Math.sqrt(minSize)) / (Math.sqrt(maxSize) - Math.sqrt(minSize))
    return 8 + t * 26 // 8px … 34px
  }

  // ---- Bubble color by weight + importance. Hue anchored to entity type
  // (people = blue family, organisations = bronze family); lightness ramps with
  // weight so heavier / more important entities read as deeper, more saturated.
  const importanceOf = (size: number) => {
    if (maxSize <= minSize) return 0.5
    return (size - minSize) / (maxSize - minSize) // 0 … 1
  }
  const nodeColor = (n: GraphNode) => {
    const t = importanceOf(n.size)
    // People: light sky blue → deep blue. Orgs: light sand → deep bronze.
    const ramp = n.type === 'organisation'
      ? ['#D9C7A8', '#B79A6A', '#8A6D45', '#5E4A2C']
      : ['#A9D3F0', '#5FA9E0', '#1D83CE', '#12547F']
    const idx = Math.min(ramp.length - 1, Math.floor(t * ramp.length))
    return ramp[idx]
  }
  const strokeFor = (n: GraphNode) => (n.type === 'organisation' ? '#5E4A2C' : '#12547F')

  // ---- Zoom / pan handlers ----
  function clampK(k: number) { return Math.min(3.5, Math.max(0.3, k)) }
  function zoomAt(factor: number, cx: number, cy: number) {
    setView((v) => {
      const k2 = clampK(v.k * factor)
      const scale = k2 / v.k
      // keep the point under (cx,cy) fixed while scaling
      return { k: k2, x: cx - (cx - v.x) * scale, y: cy - (cy - v.y) * scale }
    })
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const cx = e.clientX - (rect?.left ?? 0)
    const cy = e.clientY - (rect?.top ?? 0)
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, cx, cy)
  }
  function onPointerDown(e: React.PointerEvent) {
    // left-button drag on empty canvas pans
    if (e.button !== 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    panRef.current = { startX: e.clientX, startY: e.clientY, ox: view.x, oy: view.y, moved: false }
    setPanning(true)
  }
  function onPointerMove(e: React.PointerEvent) {
    const p = panRef.current
    if (!p) return
    const dx = e.clientX - p.startX
    const dy = e.clientY - p.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) p.moved = true
    setView((v) => ({ ...v, x: p.ox + dx, y: p.oy + dy }))
  }
  function onPointerUp() { panRef.current = null; setPanning(false) }
  function resetView() { setView({ x: 0, y: 0, k: 1 }) }

  async function openEntity(n: GraphNode) {
    // ignore clicks that were actually a pan drag
    if (panRef.current?.moved) return
    setSelected(n)
    setWiki({ answer: '', sources: [], loading: true })
    try {
      const res = await fetch('/api/wiki', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: n.id }),
      })
      const d = await res.json()
      setWiki({
        answer: d.error ? `Error: ${d.error}` : (d.answer || ''),
        sources: Array.isArray(d.sources) ? d.sources : [],
        loading: false,
      })
    } catch (e) {
      setWiki({ answer: `Error: ${(e as Error).message}`, sources: [], loading: false })
    }
  }

  return (
    <div id="memory-graph-container" ref={containerRef} style={{ position: 'relative' }}>
      {loading && <div className="memory-empty-note">Loading your memory graph…</div>}
      {err && <div className="memory-empty-note" style={{ color: '#e53935' }}>Couldn’t load graph: {err}</div>}
      {!loading && !err && nodes.length === 0 && (
        <div className="memory-empty-note">No entities yet. Once your email is parsed and the entity layer is built, people and organisations you interact with will appear here.</div>
      )}

      {nodes.length > 0 && (
        <svg
          width={width}
          height={height}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{ cursor: panning ? 'grabbing' : 'grab', touchAction: 'none' }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const a = byId[e.source], b = byId[e.target]
              if (!a || !b) return null
              const dim = selected && selected.id !== e.source && selected.id !== e.target
              return (
                <line
                  key={i}
                  className="memory-edge"
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  strokeWidth={Math.min(1 + e.weight * 0.4, 4)}
                  opacity={dim ? 0.15 : 0.55}
                />
              )
            })}
            {positioned.map((n) => {
              const r = radiusFor(n.size)
              const isSel = selected?.id === n.id
              const dim = selected && !isSel
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }} onClick={() => openEntity(n)}>
                  <circle
                    r={r}
                    fill={nodeColor(n)}
                    stroke={isSel ? strokeFor(n) : 'rgba(255,255,255,0.65)'}
                    strokeWidth={isSel ? 3 : 1.25}
                    opacity={dim ? 0.35 : 1}
                  />
                  <text
                    className="memory-node-label"
                    textAnchor="middle"
                    dy={-r - 5}
                    opacity={dim ? 0.4 : 1}
                  >
                    {displayEntityName(n.name)}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      )}

      {nodes.length > 0 && (
        <div className="memory-controls">
          <button title="Zoom in" onClick={() => zoomAt(1.2, width / 2, height / 2)}>+</button>
          <button title="Zoom out" onClick={() => zoomAt(1 / 1.2, width / 2, height / 2)}>−</button>
          <button title="Reset view" onClick={resetView}>⟳</button>
        </div>
      )}

      {selected && (
        <div className="memory-panel" style={{ maxHeight: height - 24 }}>
          <div className="memory-panel-head">
            <strong>{displayEntityName(selected.name)}</strong>
            <button className="memory-panel-close" onClick={() => { setSelected(null); setWiki(null) }} aria-label="Close">×</button>
          </div>
          <div className="memory-panel-meta">
            {selected.type} · mentioned in {selected.size} note{selected.size === 1 ? '' : 's'}
          </div>

          <div className="memory-panel-body">
            {wiki?.loading
              ? <div className="memory-panel-loading">Reading everything about them from your email…</div>
              : <WikiAnswer answer={wiki?.answer || ''} sources={wiki?.sources || []} />}
          </div>

          {!wiki?.loading && (wiki?.sources?.length ?? 0) > 0 && (
            <div className="memory-refs">
              <div className="memory-refs-title">References</div>
              <ol className="memory-refs-list">
                {wiki!.sources.map((s) => (
                  <li key={s.n} id={`ref-${selected.id}-${s.n}`}>
                    {s.url
                      ? <a href={s.url} target="_blank" rel="noopener noreferrer">{refLabel(s)}</a>
                      : <span>{refLabel(s)}</span>}
                    {s.urgency && s.urgency !== 'none' && <span className="memory-ref-tag">{s.urgency}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- Settings view ---------------- */

function SettingsView({ entwinName, setEntwinName, onLlmConfigChange }: { entwinName: string; setEntwinName: (v: string) => void; onLlmConfigChange?: () => void }) {
  const [provider, setProvider] = useState<ProviderKey>('claude')
  const [selectedModel, setSelectedModel] = useState<Record<ProviderKey, string>>({
    claude: PROVIDER_MODELS.claude[0],
    gemini: PROVIDER_MODELS.gemini[0],
    openai: PROVIDER_MODELS.openai[0],
    neocloud: PROVIDER_MODELS.neocloud[0],
    onprem: PROVIDER_MODELS.onprem[0],
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [configured, setConfigured] = useState<{ provider?: string; model?: string; endpoint?: string } | null>(null)
  const [saveErr, setSaveErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killErr, setKillErr] = useState('')
  // Tier-0 key test: null = untested, 'testing' = in flight, otherwise the
  // result. `passed` gates the "skip re-validation on save" optimization.
  const [testState, setTestState] = useState<'idle' | 'testing'>('idle')
  const [testResult, setTestResult] = useState<{ ok: boolean; reason: string; note?: string } | null>(null)
  // Entwin name save state (naming is required before Save is enabled).
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameErr, setNameErr] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [])

  // Load whether an LLM key is already configured (never the key itself).
  useEffect(() => {
    fetch('/api/settings/llm')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.configured) {
          setConfigured({ provider: d.provider, model: d.model, endpoint: d.endpoint })
          if (d.provider) setProvider(d.provider as ProviderKey)
          if (d.endpoint) setEndpoint(d.endpoint)
        }
      })
      .catch(() => {})
  }, [])

  const isSelfHosted = !!SELF_HOSTED[provider]

  // A stale test result must never linger next to a key/provider/endpoint that
  // has since changed — clear it the moment any input the test depended on moves.
  useEffect(() => {
    setTestResult(null)
  }, [apiKey, provider, endpoint])

  const backends: { value: ProviderKey; name: string; desc?: string }[] = [
    { value: 'claude', name: 'Claude API' },
    { value: 'gemini', name: 'Gemini API' },
    { value: 'openai', name: 'Open-AI API' },
    { value: 'neocloud', name: 'Neocloud', desc: 'Self-hosted LLM, rented GPU compute.' },
    { value: 'onprem', name: 'On-prem LLM', desc: 'Self-hosted LLM, runs on your own hardware.' },
  ]

  // Run a real validation probe against the provider WITHOUT saving. Catches an
  // expired / revoked / wrong-provider / wrong-scope key before the user commits.
  async function handleTest() {
    setSaveErr('')
    setTestResult(null)
    if (isSelfHosted) {
      if (!endpoint.trim()) {
        setTestResult({ ok: false, reason: 'Enter the endpoint URL to test.' })
        return
      }
    } else if (!apiKey || apiKey.length < 8) {
      setTestResult({ ok: false, reason: 'Enter an API key to test.' })
      return
    }
    setTestState('testing')
    try {
      const res = await fetch('/api/settings/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey: isSelfHosted ? apiKey || undefined : apiKey,
          endpoint: isSelfHosted ? endpoint : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      setTestResult({
        ok: !!data.ok,
        reason: data.reason || (res.ok ? 'Key verified.' : `Test failed (${res.status})`),
        note: data.embeddingsReady === false ? data.embeddingsNote : undefined,
      })
    } catch (e) {
      setTestResult({ ok: false, reason: `Could not run the test: ${(e as Error).message}` })
    } finally {
      setTestState('idle')
    }
  }

  async function handleSave() {
    setSaveErr('')
    if (isSelfHosted) {
      if (!endpoint.trim()) {
        setSaveErr('Enter the endpoint URL for the self-hosted model.')
        return
      }
    } else if (!apiKey || apiKey.length < 8) {
      setSaveErr('Enter a valid API key.')
      return
    }
    setSaving(true)
    try {
      // If the user already ran Test and it passed for exactly these inputs, the
      // server can skip its own re-probe (the offline prefix guard still runs).
      const skipValidation = testResult?.ok === true
      const res = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: selectedModel[provider],
          apiKey,
          endpoint: isSelfHosted ? endpoint : undefined,
          skipValidation,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setSaved(true)
      setConfigured({ provider, model: selectedModel[provider], endpoint: isSelfHosted ? endpoint : undefined })
      setApiKey('') // clear from memory after save; key is write-only
      setTestResult(null)
      onLlmConfigChange?.() // refresh the top-right model label app-wide
      setTimeout(() => setSaved(false), 1800)
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Persist the Entwin name. Naming is required — Save is disabled until the
  // field has a value, and the server rejects an empty name as a backstop.
  async function handleSaveName() {
    setNameErr('')
    const clean = entwinName.trim()
    if (!clean) {
      setNameErr('Please name your Entwin first.')
      return
    }
    setNameSaving(true)
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entwinName: clean }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setEntwinName(data.entwinName || clean)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 1800)
    } catch (e) {
      setNameErr((e as Error).message)
    } finally {
      setNameSaving(false)
    }
  }

  async function handleKillTwin() {
    // Double confirmation for an irreversible, total deletion.
    const ok = window.confirm(
      'Kill My Twin will permanently delete your entangled twin and all ingested data. This cannot be undone. Continue?',
    )
    if (!ok) return

    setKillErr('')
    setKilling(true)
    try {
      const res = await fetch('/api/twin', { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 207 = partial failure; surface which parts failed so they can retry.
        const detail =
          Array.isArray(data?.errors) && data.errors.length
            ? ` (${data.errors.join('; ')})`
            : data?.error
            ? ` (${data.error})`
            : ''
        throw new Error(`Deletion did not fully complete${detail}. Please try again.`)
      }
      // Twin is gone — end the session and return to the landing screen.
      await signOut({ callbackUrl: '/' })
    } catch (e) {
      setKillErr((e as Error).message)
      setKilling(false)
    }
  }

  return (
    <>
      <div className="view-header">Settings</div>
      <div id="settings-body">
        <div className="settings-section">
          <div className="settings-label">Entwin identity</div>
          <div className="settings-help">Give your entangled twin a name. It&apos;s used across the app, like in &quot;Memory&quot;.</div>
          <label className="field-label" htmlFor="entwin-name-input">Name your Entwin</label>
          <div className="key-test-row">
            <input
              type="text"
              className="text-input"
              id="entwin-name-input"
              placeholder="Entwin"
              value={entwinName}
              onChange={(e) => setEntwinName(e.target.value)}
            />
            <button
              type="button"
              className="test-btn"
              onClick={handleSaveName}
              disabled={nameSaving || !entwinName.trim()}
            >
              {nameSaving ? 'Saving…' : 'Save name'}
            </button>
          </div>
          <div>
            <span className={`save-confirm${nameSaved ? ' show' : ''}`}>Saved</span>
            {nameErr && <span className="save-confirm show" style={{ color: '#e53935' }}>{nameErr}</span>}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">LLM backend</div>
          <div className="settings-help">Choose which model powers email parsing and answers queries against the vault. Your API key is stored encrypted and used for all LLM work — parsing, embeddings, and chat.</div>

          {configured?.provider && (
            <div className="settings-help" style={{ marginTop: 8, color: 'var(--accent, #4caf50)' }}>
              Currently configured: {configured.provider} · {configured.model}. Enter a new key below to change it.
            </div>
          )}

          {backends.map((b) => (
            <label className="backend-option" key={b.value}>
              <input type="radio" name="backend" value={b.value} checked={provider === b.value} onChange={() => { setProvider(b.value); setMenuOpen(false) }} />
              <span>
                <div className="backend-option-name">{b.name}</div>
                {b.desc && <div className="backend-option-desc">{b.desc}</div>}
              </span>
            </label>
          ))}

          <div className="model-select-box" ref={boxRef}>
            <label className="field-label" style={{ marginTop: 0 }}>Model</label>
            <button className="model-select-btn" onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}>
              <span>{selectedModel[provider]}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <div className={`model-select-menu${menuOpen ? ' open' : ''}`}>
              {PROVIDER_MODELS[provider].map((m) => (
                <button
                  className={`model-select-item${m === selectedModel[provider] ? ' selected' : ''}`}
                  key={m}
                  onClick={() => { setSelectedModel((prev) => ({ ...prev, [provider]: m })); setMenuOpen(false) }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  <span>{m}</span>
                </button>
              ))}
            </div>
          </div>

          {!isSelfHosted && (
            <div id="api-key-field">
              <label className="field-label" htmlFor="api-key">API key</label>
              <div className="key-test-row">
                <input
                  type="password"
                  className="text-input"
                  id="api-key"
                  placeholder={configured?.provider === provider ? '•••••••• (set — enter to replace)' : 'Paste your API key'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="test-btn"
                  onClick={handleTest}
                  disabled={testState === 'testing' || apiKey.length < 8}
                >
                  {testState === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
            </div>
          )}
          {isSelfHosted && (
            <div id="endpoint-field">
              <label className="field-label" htmlFor="endpoint-input">{provider === 'neocloud' ? 'Endpoint URL' : 'Host address'}</label>
              <div className="key-test-row">
                <input
                  type="text"
                  className="text-input"
                  id="endpoint-input"
                  placeholder={provider === 'neocloud' ? 'https://your-neocloud-instance.example.com' : 'http://localhost:11434/v1'}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="test-btn"
                  onClick={handleTest}
                  disabled={testState === 'testing' || !endpoint.trim()}
                >
                  {testState === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
              <label className="field-label" htmlFor="endpoint-key" style={{ marginTop: 10 }}>API key (optional)</label>
              <input
                type="password"
                className="text-input"
                id="endpoint-key"
                placeholder="Leave blank if the endpoint needs no key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {testResult && (
            <div className={`key-test-result ${testResult.ok ? 'ok' : 'fail'}`} role="status">
              <span className="key-test-icon">{testResult.ok ? '✓' : '✕'}</span>
              <span>
                {testResult.reason}
                {testResult.note && <div className="key-test-note">{testResult.note}</div>}
              </span>
            </div>
          )}

          <div>
            <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
            <span className={`save-confirm${saved ? ' show' : ''}`}>Saved</span>
            {saveErr && <span className="save-confirm show" style={{ color: '#e53935' }}>{saveErr}</span>}
          </div>
        </div>

        <div className="kill-twin-row">
          {killErr && <span className="kill-twin-err">{killErr}</span>}
          <button
            type="button"
            className="kill-twin-btn"
            onClick={handleKillTwin}
            disabled={killing}
          >
            {killing ? 'Deleting…' : 'Kill My Twin'}
          </button>
        </div>
      </div>
    </>
  )
}

/* ---------------- All chats view ---------------- */

type ChatDateRange = 'all' | 'today' | '7d' | '30d' | 'custom'

interface StoredChatSource {
  n: number
  url: string | null
  date: string | null
  urgency: string | null
  channel?: string | null
  similarity?: number
}
interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources: StoredChatSource[]
  isError: boolean
  model: string | null
  seq: number
  createdAt: string
}
interface StoredChatSession {
  clientId: string
  title: string
  createdAt: string
  updatedAt: string
  messages: StoredChatMessage[]
}

/** Format an ISO instant as e.g. "Aug 9, 2026 · 3:04 PM". */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date} \u00b7 ${time}`
}

/** Human day bucket label for a conversation's last-active date. */
function dayBucket(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'EARLIER'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayMs = 86400000
  if (t === startOfToday) return 'TODAY'
  if (t === startOfToday - dayMs) return 'YESTERDAY'
  if (t > startOfToday - 7 * dayMs) return 'EARLIER THIS WEEK'
  if (t > startOfToday - 30 * dayMs) return 'EARLIER THIS MONTH'
  return 'OLDER'
}

/** Convert a UI date range to an ISO "since" filter (or null for all-time). */
function rangeSince(range: ChatDateRange, customStart: string): string | null {
  const now = new Date()
  if (range === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return d.toISOString()
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 86400000).toISOString()
  if (range === '30d') return new Date(now.getTime() - 30 * 86400000).toISOString()
  if (range === 'custom' && customStart) {
    const d = new Date(customStart)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return null
}

function AllChatsView({ refreshKey }: { refreshKey: number }) {
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<ChatDateRange>('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [sessions, setSessions] = useState<StoredChatSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Debounce the free-text search so we don't fetch on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(h)
  }, [query])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (debouncedQuery.trim()) params.set('search', debouncedQuery.trim())
        const since = rangeSince(range, customStart)
        if (since) params.set('since', since)
        const res = await fetch(`/api/chats?${params.toString()}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
        if (!cancelled) setSessions((data.sessions as StoredChatSession[]) || [])
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, range, customStart, refreshKey])

  // Apply the custom "To" bound client-side (the API filters only on "since").
  const visible = useMemo(() => {
    if (range !== 'custom' || !customEnd) return sessions
    const endD = new Date(customEnd)
    if (isNaN(endD.getTime())) return sessions
    const endMs = endD.getTime() + 86400000 // inclusive of the end day
    return sessions.filter((s) => new Date(s.updatedAt).getTime() < endMs)
  }, [sessions, range, customEnd])

  // Group conversations (already newest-first from the API) into day buckets,
  // preserving order.
  const groups = useMemo(() => {
    const out: { label: string; items: StoredChatSession[] }[] = []
    for (const s of visible) {
      const label = dayBucket(s.updatedAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(s)
      else out.push({ label, items: [s] })
    }
    return out
  }, [visible])

  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }))

  return (
    <div className="allchats-wrap">
      <div className="allchats-controls">
        <div className="allchats-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search all chats\u2026"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search all chats"
          />
        </div>

        <select
          className="allchats-range"
          value={range}
          onChange={(e) => setRange(e.target.value as ChatDateRange)}
          aria-label="Filter by date"
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="custom">Custom range\u2026</option>
        </select>
      </div>

      {range === 'custom' && (
        <div className="allchats-custom-row">
          <label className="allchats-custom-field">
            <span>From</span>
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
          </label>
          <label className="allchats-custom-field">
            <span>To</span>
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </label>
        </div>
      )}

      {loading ? (
        <div className="allchats-empty">Loading your chats\u2026</div>
      ) : error ? (
        <div className="allchats-empty" style={{ color: '#e53935' }}>{error}</div>
      ) : visible.length === 0 ? (
        <div className="allchats-empty">
          {query.trim() || range !== 'all'
            ? 'No chats match your filters.'
            : 'No saved chats yet. Start a conversation and it will show up here.'}
        </div>
      ) : (
        groups.map((g) => (
          <div className="allchats-group" key={g.label}>
            <div className="allchats-section-label">{g.label}</div>
            {g.items.map((s) => {
              const open = !!expanded[s.clientId]
              const turnCount = s.messages.length
              return (
                <div className={`allchats-card${open ? ' open' : ''}`} key={s.clientId}>
                  <button className="allchats-card-head" onClick={() => toggle(s.clientId)}>
                    <div className="allchats-card-main">
                      <div className="allchats-card-title">{s.title}</div>
                      <div className="allchats-card-meta">
                        {formatStamp(s.updatedAt)} \u00b7 {turnCount} message{turnCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <svg
                      className="allchats-chevron"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {open && (
                    <div className="allchats-thread">
                      {s.messages.map((m) => (
                        <div className={`msg ${m.role}`} key={m.id}>
                          <div className="role-label">
                            {m.role === 'user' ? 'You' : 'Entwin'}
                            <span className="allchats-msg-time">{formatStamp(m.createdAt)}</span>
                          </div>
                          <div className="bubble" style={m.isError ? { color: '#e53935' } : undefined}>
                            {m.text}
                          </div>
                          {m.sources && m.sources.length > 0 && (
                            <div
                              className="msg-sources"
                              style={{ marginTop: 6, fontSize: 12, opacity: 0.8, display: 'flex', flexWrap: 'wrap', gap: 8 }}
                            >
                              {m.sources.map((src) =>
                                src.url ? (
                                  <a
                                    key={src.n}
                                    href={src.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ textDecoration: 'none' }}
                                  >
                                    [{src.n}] {src.date || 'email'}
                                    {src.urgency ? ` \u00b7 ${src.urgency}` : ''}
                                  </a>
                                ) : (
                                  <span key={src.n}>
                                    [{src.n}] {src.date || 'email'}
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}

/* ---------------- App shell ---------------- */

const NAV: { key: ViewKey; label: string; icon: JSX.Element }[] = [
  { key: 'chat', label: 'Chat', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg> },
  { key: 'allchats', label: 'All chats', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg> },
  { key: 'connectors', label: 'Connectors', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 2v6M15 2v6M6 8h12l-1 5a5 5 0 0 1-10 0z" /><path d="M12 17v5" /></svg> },
  { key: 'dashboard', label: 'Dashboard', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg> },
  { key: 'memory', label: 'Memory', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="7" r="2.3" /><circle cx="10.5" cy="18" r="2.3" /><line x1="8.1" y1="6.6" x2="15.9" y2="6.9" /><line x1="7.4" y1="7.9" x2="9.6" y2="16" /><line x1="16.6" y1="8.9" x2="12.4" y2="16.4" /></svg> },
  { key: 'settings', label: 'Settings', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" /></svg> },
]

function AppShell() {
  const { data: session } = useSession()
  const user = session?.user
  const name = user?.name || 'Alex Whitmore'
  const email = user?.email || 'you@example.com'
  const initials = useMemo(
    () => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
    [name],
  )

  const [collapsed, setCollapsed] = useState(false)
  const [view, setView] = useState<ViewKey>('chat')
  const [chatResetKey, setChatResetKey] = useState(0)
  const [allChatsRefresh, setAllChatsRefresh] = useState(0)

  // LLM label shown top-right on every tab. Reflects the user's configured
  // model, or prompts to set an API key when none is stored. Loaded on mount and
  // refreshed whenever the user saves a key in Settings (via refreshLlmLabel).
  const [currentModel, setCurrentModel] = useState('')
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null) // null = still loading

  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userWrapRef = useRef<HTMLDivElement>(null)

  const [connectors, setConnectors] = useState<Connector[]>(INITIAL_CONNECTORS)
  const [gmailNotice, setGmailNotice] = useState<string | null>(null)
  const [waModalOpen, setWaModalOpen] = useState(false)
  const [entities, setEntities] = useState<Entity[]>(INITIAL_ENTITIES)
  const [entwinName, setEntwinName] = useState('')

  // Load the persisted Entwin name (survives reload / device switch). Falls back
  // to empty when never set, which the Settings tab surfaces as a required field.
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.entwinName) setEntwinName(d.entwinName)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const connectedCount = connectors.filter((c) => c.connected).length

  // Load the user's LLM config for the top-right label. Kept in a callback so
  // Settings can trigger a refresh right after the user saves a key.
  const refreshLlmLabel = useMemo(
    () => async () => {
      try {
        const res = await fetch('/api/settings/llm')
        if (!res.ok) {
          setLlmConfigured(false)
          return
        }
        const d = await res.json()
        if (d?.configured) {
          setLlmConfigured(true)
          setCurrentModel(d.model || d.provider || 'Model configured')
        } else {
          setLlmConfigured(false)
          setCurrentModel('')
        }
      } catch {
        setLlmConfigured(false)
      }
    },
    [],
  )

  useEffect(() => {
    refreshLlmLabel()
  }, [refreshLlmLabel])

  // On mount, restore this user's saved connector state: the Connect/Disconnect
  // toggle of every card AND each card's settings. This runs FIRST; the
  // real-backend hydrators below (Gmail return-flow, Slack status, WhatsApp
  // status) run afterward and override the `connected` flag for the cards they
  // authoritatively own — so a revoked-at-source connection can never be shown
  // as connected just because it was once saved. Settings always come from here.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/connectors/state')
        if (!res.ok) return
        const { states } = (await res.json()) as {
          states: Record<string, { connected: boolean; settings: ConnectorSettings; lastReadAt?: string | null }>
        }
        if (cancelled || !states) return
        setConnectors((prev) =>
          prev.map((c) => {
            const saved = states[c.key]
            if (!saved) return c
            return {
              ...c,
              // Restore the saved toggle for backend-less cards. Backend-owned
              // cards (gmail/slack/whatsapp) also get the saved value here as a
              // fast paint; their status effects reconcile it moments later.
              connected: saved.connected,
              settings: saved.settings,
              lastReadAt: saved.lastReadAt ?? null,
              // A row exists for this card → its grid Connect button is enabled.
              settingsPersisted: true,
            }
          }),
        )
      } catch {
        /* non-fatal: fall back to defaults */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Kicks off a real Gmail scan: mark the card connected + scanning, pull the
  // deduped inbox/sent counts from the backend, then show them in small font.
  const runGmailScan = useMemo(
    () =>
      async (cardId: NonNullable<Connector['cardId']>) => {
        // Pull the connected account email so the card can label itself.
        let connectedEmail: string | null = null
        try {
          const st = await fetch(`/api/gmail/status?card=${cardId}`)
          if (st.ok) connectedEmail = (await st.json()).connectedEmail ?? null
        } catch {
          /* ignore */
        }

        setConnectors((prev) =>
          prev.map((c) =>
            c.cardId === cardId
              ? { ...c, connected: true, connectedEmail, scanning: true, scan: null }
              : c,
          ),
        )
        // Persist the durable connect flag so it survives a browser close /
        // reopen. Without this, connector_state.connected stays false for the
        // Gmail card and the grid would repaint "Connect" on the next load.
        // Keyed by the card's connector slug (same as cardId).
        persistConnectorState(cardId, { connected: true })

        try {
          const res = await fetch('/api/gmail/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: cardId }),
          })
          const raw = await res.text()
          let payload: { inboxCount?: number; sentCount?: number; error?: string } = {}
          if (raw) {
            try {
              payload = JSON.parse(raw)
            } catch {
              // Empty/truncated body — almost always the serverless function was
              // killed mid-scan (timeout on a large mailbox). Give a real message.
              throw new Error(
                res.ok
                  ? 'The scan was cut off before it finished (likely a timeout on a large mailbox). Try again, or see notes on capping the scan.'
                  : `scan failed (${res.status})`,
              )
            }
          }
          if (!res.ok) throw new Error(payload.error || `scan failed (${res.status})`)
          setConnectors((prev) =>
            prev.map((c) =>
              c.cardId === cardId
                ? {
                    ...c,
                    scanning: false,
                    scan: { inboxCount: payload.inboxCount ?? 0, sentCount: payload.sentCount ?? 0 },
                  }
                : c,
            ),
          )
          // Kick off the async ingestion (gmail-calibrate GitHub Actions
          // worker) and enter the "Ingestion is in-progress" state. A polling
          // effect watches /api/gmail/ingest-status and flips to the ingested
          // count when the job completes.
          fetch('/api/gmail/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: cardId }),
          }).catch(() => {
            /* non-fatal: backfill can be retried from the dashboard */
          })
          setConnectors((prev) =>
            prev.map((c) =>
              c.cardId === cardId
                ? { ...c, ingesting: true, ingestDone: false, ingestedCount: null }
                : c,
            ),
          )
        } catch (e) {
          setGmailNotice(`Gmail scan failed: ${(e as Error).message}`)
          setConnectors((prev) =>
            prev.map((c) => (c.cardId === cardId ? { ...c, scanning: false } : c)),
          )
        }
      },
    [],
  )

  // Kicks off a real Slack read: mark the card connected + scanning, pull the
  // last 1 month of chats across all conversations, then show the counts.
  const runSlackScan = useMemo(
    () =>
      async (cardId: NonNullable<Connector['slackCardId']>) => {
        // Pull the connected workspace name so the card can label itself.
        let slackTeam: string | null = null
        try {
          const st = await fetch(`/api/slack/status?card=${cardId}`)
          if (st.ok) slackTeam = (await st.json()).teamName ?? null
        } catch {
          /* ignore */
        }

        setConnectors((prev) =>
          prev.map((c) =>
            c.slackCardId === cardId
              ? { ...c, connected: true, slackTeam, scanning: true, slackScan: null }
              : c,
          ),
        )

        try {
          const res = await fetch('/api/slack/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: cardId }),
          })
          const raw = await res.text()
          let payload: {
            totalMessages?: number
            activeChannels?: number
            scannedChannels?: number
            channels?: SlackChannelCount[]
            windowDays?: number
            error?: string
          } = {}
          if (raw) {
            try {
              payload = JSON.parse(raw)
            } catch {
              throw new Error(
                res.ok
                  ? 'The read was cut off before it finished (likely a timeout on a large workspace). Try again.'
                  : `scan failed (${res.status})`,
              )
            }
          }
          if (!res.ok) throw new Error(payload.error || `scan failed (${res.status})`)
          setConnectors((prev) =>
            prev.map((c) =>
              c.slackCardId === cardId
                ? {
                    ...c,
                    scanning: false,
                    slackScan: {
                      totalMessages: payload.totalMessages ?? 0,
                      activeChannels: payload.activeChannels ?? 0,
                      scannedChannels: payload.scannedChannels ?? 0,
                      channels: payload.channels ?? [],
                      windowDays: payload.windowDays ?? 30,
                    },
                  }
                : c,
            ),
          )
          // Kick off the async 1-month backfill (GitHub Actions worker). This is
          // fire-and-forget: it registers the account for syncing and queues the
          // capture + vectorize job. Failure here doesn't affect the scan
          // result already shown to the user.
          fetch('/api/slack/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: cardId }),
          }).catch(() => {
            /* non-fatal: backfill can be retried from the dashboard */
          })
        } catch (e) {
          setGmailNotice(`Slack read failed: ${(e as Error).message}`)
          setConnectors((prev) =>
            prev.map((c) => (c.slackCardId === cardId ? { ...c, scanning: false } : c)),
          )
        }
      },
    [],
  )

  // Pull live WhatsApp status and fold it into the WhatsApp connector card.
  const refreshWhatsAppStatus = useMemo(
    () => async () => {
      try {
        const res = await fetch('/api/whatsapp/status')
        if (!res.ok) return
        const st = (await res.json()) as WaStatus
        setConnectors((prev) =>
          prev.map((c) =>
            c.service === 'whatsapp'
              ? { ...c, wa: st, connected: st.state === 'connected' }
              : c,
          ),
        )
      } catch {
        /* ignore */
      }
    },
    [],
  )

  // Poll WhatsApp status while linked (or pairing) so captured/vectorized
  // counts stay fresh on the card. Cheap GET; backs off when disconnected.
  useEffect(() => {
    refreshWhatsAppStatus()
    const wa = connectors.find((c) => c.service === 'whatsapp')?.wa
    const active = wa?.state === 'connected' || wa?.state === 'pairing'
    const interval = setInterval(refreshWhatsAppStatus, active ? 15000 : 60000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshWhatsAppStatus, connectors.find((c) => c.service === 'whatsapp')?.wa?.state])

  // On return from Google consent (?gmail=connected&card=...), open the
  // Connectors view and start the scan for that card.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const gmail = params.get('gmail')
    const card = params.get('card')
    if (gmail === 'connected' && (card === 'gmail-personal' || card === 'gmail-professional')) {
      setView('connectors')
      runGmailScan(card)
    } else if (gmail === 'denied') {
      setView('connectors')
      setGmailNotice('Gmail connection was cancelled — you did not grant access.')
    } else if (gmail === 'error') {
      // Surface the real reason instead of silently returning to home.
      const reason = params.get('reason')
      setView('connectors')
      setGmailNotice(
        `Gmail connection failed${reason ? `: ${decodeURIComponent(reason)}` : ''}. Please try again.`,
      )
    }
    if (gmail) {
      // Clean the URL so a refresh doesn't re-trigger the flow.
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [runGmailScan])

  // On mount, hydrate BOTH Gmail cards from their server-side session so a
  // connected account — its email, its last inbox/sent counts, and therefore
  // the Connect/Disconnect button state — survives a page refresh. Without
  // this, the connector-state hydrator above restores only the `connected`
  // flag (a fast paint), but the scan counts and connected email would be lost
  // on reload, and if the source token was revoked the card would wrongly stay
  // "connected". This is the Gmail equivalent of the Slack hydrator below and
  // is authoritative for these cards' connected flag.
  useEffect(() => {
    let cancelled = false
    const cards: NonNullable<Connector['cardId']>[] = ['gmail-personal', 'gmail-professional']
    ;(async () => {
      await Promise.all(
        cards.map(async (cardId) => {
          try {
            const res = await fetch(`/api/gmail/status?card=${cardId}`)
            if (!res.ok) return
            const st = (await res.json()) as {
              state: string
              connectedEmail: string | null
              scan: { inboxCount: number; sentCount: number } | null
              storeConfigured?: boolean
            }
            if (cancelled) return
            const statusConnected = st.state === 'connected'
            setConnectors((prev) =>
              prev.map((c) => {
                if (c.cardId !== cardId) return c
                // Authoritative ONLY when the durable token store is configured:
                // then `disconnected` truly means no token. When the store isn't
                // configured, a `disconnected` reading may just be a lost
                // in-memory session after a restart — in that case keep the
                // persisted connect flag the connector-state hydrator painted,
                // so a real connection survives a browser close / reopen.
                const connected =
                  statusConnected || (st.storeConfigured === false && c.connected)
                return {
                  ...c,
                  connected,
                  connectedEmail: connected ? st.connectedEmail ?? c.connectedEmail ?? null : null,
                  // Restore prior counts; clear them if not connected.
                  scan:
                    connected && st.scan
                      ? { inboxCount: st.scan.inboxCount, sentCount: st.scan.sentCount }
                      : connected
                      ? c.scan ?? null
                      : null,
                  scanning: false,
                }
              }),
            )
          } catch {
            /* ignore — connector-state hydrator already painted a best guess */
          }
        }),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Gmail ingestion status: hydrate on mount and poll while a card is ingesting.
  // The count and completion come from the DB (/api/gmail/ingest-status), which
  // reflects what the gmail-calibrate worker has written — so a browser reload
  // during ingestion resumes the "in-progress" state, and a completed job shows
  // "Total X emails ingested" without any local memory of the run.
  useEffect(() => {
    let cancelled = false
    const cards: NonNullable<Connector['cardId']>[] = ['gmail-personal', 'gmail-professional']

    const poll = async () => {
      await Promise.all(
        cards.map(async (cardId) => {
          try {
            const res = await fetch(`/api/gmail/ingest-status?card=${cardId}`)
            if (!res.ok) return
            const st = (await res.json()) as {
              ingestedCount: number
              done: boolean
              inProgress: boolean
            }
            if (cancelled) return
            setConnectors((prev) =>
              prev.map((c) => {
                if (c.cardId !== cardId) return c
                // Don't paint ingestion state on a card the user has disconnected;
                // its sync_state may briefly linger. Connected cards only.
                if (!c.connected) return c
                // Only reflect ingestion state for a connected card that has a
                // dispatched job (inProgress) or a completed one (done).
                if (st.inProgress) {
                  return { ...c, ingesting: true, ingestDone: false, ingestedCount: st.ingestedCount }
                }
                if (st.done) {
                  return { ...c, ingesting: false, ingestDone: true, ingestedCount: st.ingestedCount }
                }
                return c
              }),
            )
          } catch {
            /* ignore — non-fatal */
          }
        }),
      )
    }

    // Prime immediately, then poll on an interval. The interval is cheap (two
    // head-count queries) and self-limiting: it only changes anything while a
    // job is in progress.
    poll()
    const t = setInterval(poll, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  // On mount, hydrate the Slack card from server state so a connected
  // workspace (and its last read) survives a page refresh.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/slack/status?card=slack-workspace')
        if (!res.ok) return
        const st = (await res.json()) as {
          state: string
          teamName: string | null
          scan: SlackScan | null
        }
        if (cancelled || st.state !== 'connected') return
        setConnectors((prev) =>
          prev.map((c) =>
            c.slackCardId === 'slack-workspace'
              ? { ...c, connected: true, slackTeam: st.teamName, slackScan: st.scan }
              : c,
          ),
        )
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // On return from Slack consent (?slack=connected&card=...), open the
  // Connectors view and pull the last 1 month of chats for that card.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const slack = params.get('slack')
    const card = params.get('card')
    if (slack === 'connected' && card === 'slack-workspace') {
      setView('connectors')
      runSlackScan(card)
    } else if (slack === 'denied') {
      setView('connectors')
      setGmailNotice('Slack connection was cancelled — you did not grant access.')
    } else if (slack === 'error') {
      const reason = params.get('reason')
      setView('connectors')
      setGmailNotice(
        `Slack connection failed${reason ? `: ${decodeURIComponent(reason)}` : ''}. Please try again.`,
      )
    }
    if (slack) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [runSlackScan])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (userWrapRef.current && !userWrapRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [])

  const memoryTitle = `${entwinName.trim() || 'Entwin'}'s Memory`

  return (
    <div id="app-shell" style={{ display: 'flex' }}>
      <div id="sidebar" className={collapsed ? 'collapsed' : ''}>
        <div className="sidebar-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_DATA_URI} width={20} height={20} alt="" style={{ flexShrink: 0, objectFit: 'contain' }} />
            <span className="wordmark">Entwin</span>
          </div>
          <button className="icon-btn" aria-label="Collapse sidebar" onClick={() => setCollapsed((c) => !c)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /></svg>
          </button>
        </div>

        <div className="new-chat-wrap">
          <button className="new-chat-btn" onClick={() => { setView('chat'); setChatResetKey((k) => k + 1) }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span className="label">New chat</span>
          </button>
        </div>

        <nav className="nav-list">
          {NAV.map((n) => (
            <button className={`nav-item${view === n.key ? ' active' : ''}`} key={n.key} onClick={() => setView(n.key)}>
              {n.icon}
              <span className="label">{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-bottom">
          <div className="user-menu-wrap" ref={userWrapRef}>
            <div id="user-menu" className={userMenuOpen ? 'open' : ''}>
              <div className="user-menu-email">{email}</div>
              <button className="user-menu-item" onClick={() => signOut({ callbackUrl: '/' })}>Sign out</button>
            </div>
            <button className="user-row" onClick={() => setUserMenuOpen((o) => !o)}>
              <span className="avatar">{initials}<span className="status-dot" aria-hidden="true" /></span>
              <span className="user-meta">
                <div className="user-name">{name}</div>
                <div className="user-sub">{email}</div>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div id="main">
        {/* Global model / API-key label, top-right of every tab. */}
        {llmConfigured !== null && (
          llmConfigured ? (
            <div className="llm-status-label" title={`Active model: ${currentModel}`}>
              {currentModel}
            </div>
          ) : (
            <button
              type="button"
              className="llm-status-label llm-status-unset"
              onClick={() => setView('settings')}
              title="No LLM API key set — click to configure"
            >
              Set API Key for LLM
            </button>
          )
        )}
        {/* CHAT */}
        <div className={`view${view === 'chat' ? ' active' : ''}`} id="view-chat">
          <div className="view-header chat-header">
            <div>Chat<div className="sub">{
              llmConfigured === null
                ? 'Checking model…'
                : llmConfigured
                ? `Answering from your vault${currentModel ? ` · ${currentModel}` : ''}`
                : 'No model connected — set an API key in Settings'
            }</div></div>
          </div>
          {view === 'chat' && <ChatView currentModel={currentModel} resetKey={chatResetKey} onPersisted={() => setAllChatsRefresh((k) => k + 1)} />}
        </div>

        {/* ALL CHATS */}
        <div className={`view${view === 'allchats' ? ' active' : ''}`} id="view-allchats">
          <div className="view-header">All chats<div className="sub">Every past Entwin conversation, searchable by text or date</div></div>
          {view === 'allchats' && <AllChatsView refreshKey={allChatsRefresh} />}
        </div>

        {/* CONNECTORS */}
        <div className={`view${view === 'connectors' ? ' active' : ''}`} id="view-connectors">
          <div className="view-header">Connectors<div className="sub">Sources feeding the vault</div></div>
          <ConnectorsView connectors={connectors} setConnectors={setConnectors} runGmailScan={runGmailScan} openWhatsApp={() => setWaModalOpen(true)} notice={gmailNotice} clearNotice={() => setGmailNotice(null)} />
        </div>

        {/* DASHBOARD */}
        <div className={`view${view === 'dashboard' ? ' active' : ''}`} id="view-dashboard">
          <DashboardView connectedCount={connectedCount} total={connectors.length} entities={entities} setEntities={setEntities} />
        </div>

        {/* MEMORY */}
        <div className={`view${view === 'memory' ? ' active' : ''}`} id="view-memory">
          <div className="view-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', paddingRight: 200 }}>
            <span>{memoryTitle}<div className="sub">How the pieces your Entwin knows connect to each other</div></span>
            <RebuildGraphButton />
          </div>
          {view === 'memory' && <MemoryGraph />}
        </div>

        {/* SETTINGS */}
        <div className={`view${view === 'settings' ? ' active' : ''}`} id="view-settings">
          <SettingsView entwinName={entwinName} setEntwinName={setEntwinName} onLlmConfigChange={refreshLlmLabel} />
        </div>
      </div>

      {waModalOpen && (
        <WhatsAppModal
          onClose={() => setWaModalOpen(false)}
          onLinked={refreshWhatsAppStatus}
        />
      )}
    </div>
  )
}

/* ---------------- Root ---------------- */

export default function Home() {
  const { status } = useSession()

  if (status === 'loading') {
    return <div id="login-screen" style={{ display: 'flex' }}><div className="login-card"><div className="login-sub">Loading…</div></div></div>
  }

  if (status !== 'authenticated') {
    return <LoginScreen />
  }

  return <AppShell />
}
