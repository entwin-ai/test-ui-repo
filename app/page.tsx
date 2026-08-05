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

type ViewKey = 'chat' | 'connectors' | 'dashboard' | 'memory' | 'settings'
type DashTab = 'overview' | 'kanban' | 'entities'
type ListKey = 'marketing' | 'updates' | 'people'
type ProviderKey = 'claude' | 'gemini' | 'openai' | 'neocloud' | 'onprem'

/* ---------------- Static data (from v3 HTML) ---------------- */

const MODELS = [
  { name: 'Claude Opus 4.8', desc: 'Most capable, best for complex work' },
  { name: 'Claude Sonnet 5', desc: 'Balanced for everyday use' },
  { name: 'Claude Haiku 4.5', desc: 'Fastest, best for quick tasks' },
]

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
  // Gmail cards get a stable id used by the real OAuth + scan backend.
  cardId?: 'gmail-personal' | 'gmail-professional'
  // Slack card gets its own stable id used by the real Slack OAuth + scan backend.
  slackCardId?: 'slack-workspace'
  // Local UI state for the Gmail read/parse flow.
  scanning?: boolean
  scan?: GmailScan | null
  // Local UI state for the Slack 1-month read flow.
  slackScan?: SlackScan | null
  slackTeam?: string | null
  // WhatsApp live state (real Baileys backend).
  wa?: WaStatus | null
}

const INITIAL_CONNECTORS: Connector[] = [
  { name: 'Gmail — Personal', service: 'gmail', icon: 'gmail', cardId: 'gmail-personal', key: 'gmail-personal', desc: 'Email ingestion for the vault.', connected: false, connectedEmail: null, scan: null },
  { name: 'Gmail — Professional', service: 'gmail', icon: 'gmail', cardId: 'gmail-professional', key: 'gmail-professional', desc: 'Email ingestion for the vault.', connected: false, connectedEmail: null, scan: null },
  { name: 'Google Drive — Personal', service: 'drive', icon: 'drive', key: 'drive-personal', desc: 'Document ingestion for the vault.', connected: false, connectedEmail: null },
  { name: 'Google Drive — Professional', service: 'drive', icon: 'drive', key: 'drive-professional', desc: 'Document ingestion for the vault.', connected: false, connectedEmail: null },
  { name: 'Google Calendar', service: null, icon: 'calendar', key: 'calendar', desc: 'Meeting and scheduling context.', connected: false, connectedEmail: null },
  { name: 'WhatsApp', service: 'whatsapp', code: 'WA', key: 'whatsapp', desc: 'Personal messages, vectorized into cross-channel memory.', connected: false, connectedEmail: null, wa: null },
  { name: 'Animatics', service: null, icon: 'animatics', key: 'animatics', desc: 'Create Anime from your Novel', connected: false, connectedEmail: null },
  { name: 'Slack', service: 'slack', icon: 'slack', slackCardId: 'slack-workspace', key: 'slack-workspace', desc: 'Work channel ingestion — pulls the last 1 month of Slack chats.', connected: false, connectedEmail: null, slackScan: null },
  { name: 'Browser history', service: null, code: 'BH', key: 'browser-history', desc: 'Search activity as raw source.', connected: false, connectedEmail: null },
]

/**
 * Persist one connector card's state for the current user. Fire-and-forget:
 * `connected` alone records a Connect/Disconnect click, `settings` alone records
 * a "Save settings" click; either may be sent without disturbing the other.
 * Returns true on success so callers that need to confirm (the modal) can.
 */
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
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const handleGoogle = () => {
    setBusy(true)
    // Real Google OAuth via NextAuth — redirects to accounts.google.com
    signIn('google', { callbackUrl: '/' })
  }

  const handleEmail = () => {
    setNote("Email sign-in isn't wired up in this prototype — use Google to continue.")
    setTimeout(() => setNote(''), 3000)
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

        <div className="login-divider">or</div>
        <button className="login-email-link" id="email-login-btn" onClick={handleEmail}>Continue with email</button>
        <div className="login-note" id="login-note">{note}</div>

        <div className="login-footer">By continuing, you agree to Entwin&apos;s Terms and acknowledge the Privacy Policy.</div>
      </div>
    </div>
  )
}

/* ---------------- Chat view ---------------- */

interface AskSource { n: number; url: string | null; date: string | null; urgency: string | null }
interface ChatMsg { role: 'user' | 'assistant'; text: string; sources?: AskSource[]; error?: boolean }

function ChatView({ currentModel, resetKey }: { currentModel: string; resetKey: number }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', text: 'Hi, I\u2019m Entwin. Ask me anything about your email \u2014 what\u2019s outstanding, who\u2019s waiting on you, upcoming payments or deadlines \u2014 and I\u2019ll answer from your vault.' },
  ])
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (resetKey > 0) setMessages([{ role: 'assistant', text: 'New chat started. What would you like to know?' }])
  }, [resetKey])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, pending])

  const send = async () => {
    const text = value.trim()
    if (!text || pending) return
    setMessages((m) => [...m, { role: 'user', text }])
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setPending(true)

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
        setMessages((m) => [...m, { role: 'assistant', text: msg, error: true }])
      } else {
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: data.answer || 'No answer returned.', sources: data.sources || [] },
        ])
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: `Network error: ${(e as Error).message}`, error: true },
      ])
    } finally {
      setPending(false)
    }
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

  // Animatics Phase 1 flow modal (novel → cast → screenplay → approve).
  const [animaticsOpen, setAnimaticsOpen] = useState(false)
  // Whether an Animatics run currently exists (drives Connect/Disconnect label).
  const [animaticsConnected, setAnimaticsConnected] = useState(false)

  // Index of the connector whose settings panel is open (null = closed).
  const [settingsIdx, setSettingsIdx] = useState<number | null>(null)
  const openConnectorSettings = (idx: number) => setSettingsIdx(idx)
  const closeConnectorSettings = () => setSettingsIdx(null)

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

  const toggle = (idx: number) => {
    const c = connectors[idx]

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
            i === idx ? { ...x, connected: false, connectedEmail: null, scan: null, scanning: false } : x,
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

    // Everything else (Drive, Calendar, Browser history) has no backend of its
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
    <div id="connectors-grid">
      {connectors.map((c, idx) => {
        const gmail = isGmail(c)
        const whatsapp = isWhatsApp(c)
        const slack = isSlack(c)
        const animatics = c.icon === 'animatics'
        let statusText: string
        if (whatsapp && c.wa) {
          if (c.wa.state === 'pairing') statusText = 'Pairing — enter code on phone'
          else if (c.wa.state === 'connected') statusText = 'Linked · syncs hourly'
          else statusText = 'Not connected'
        } else if (slack && c.connected) {
          statusText = c.slackTeam ? `Connected · ${c.slackTeam}` : 'Connected'
        } else if (c.connected) {
          statusText = c.connectedEmail ? `Connected as ${c.connectedEmail}` : 'Connected'
        } else {
          statusText = 'Not connected'
        }

        // Buttons: Gmail scanning shows a disabled "Reading…" state.
        const btnLabel = animatics
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
            <div className="connector-desc">{c.desc}</div>

            {/* Gmail read summary — small font, inbox + sent counts. */}
            {gmail && c.connected && (c.scanning || c.scan) && (
              <div className="gmail-scan-summary">
                {c.scanning ? (
                  <span className="gmail-scan-loading">Reading your last 12 months of mail…</span>
                ) : c.scan ? (
                  <>
                    <span>Inbox read: {c.scan.inboxCount.toLocaleString()} messages</span>
                    <span>Sent read: {c.scan.sentCount.toLocaleString()} messages</span>
                  </>
                ) : null}
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

            <div className="connector-bottom">
              {animatics ? (
                <span className="connector-status off" style={{ visibility: 'hidden' }}></span>
              ) : (
                <span className={`connector-status ${c.connected ? 'connected' : 'off'}`}>{statusText}</span>
              )}
              <div className="connector-actions">
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
                <button
                  className={`connect-toggle ${(animatics ? animaticsConnected : c.connected) ? 'connected' : ''}`}
                  onClick={() => toggle(idx)}
                  disabled={c.scanning}
                >
                  {btnLabel}
                </button>
              </div>
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
            prev.map((x) => (x.key === key ? { ...x, settings } : x)),
          )
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
}: {
  connector: Connector
  onClose: () => void
  // Persist + reflect a Connect/Disconnect made from inside the modal.
  onConnectChange: (connected: boolean) => void
  // Reflect saved settings back into the parent's connector list.
  onSettingsSaved: (settings: ConnectorSettings) => void
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

  // Uniform connect/disconnect state, local to the modal (every connector
  // behaves identically in this build — see Engineering Considerations).
  const [connected, setConnected] = useState(initiallyConnected)
  const [checking, setChecking] = useState(false)
  const [showDisclaimer, setShowDisclaimer] = useState(false)

  // In this build there is no UI to flip this — a re-connect always resolves
  // to "still active at source", so it flips straight back to Disconnect.
  const sourceStillActive = true

  // Seed the steppers from this card's persisted per-user settings (falling
  // back to defaults for a card the user has never saved).
  const seed = connector.settings ?? DEFAULT_CONNECTOR_SETTINGS
  const [pollHours, setPollHours] = useState(seed.pollHours)
  const [backfillDays, setBackfillDays] = useState(seed.backfillDays)
  const totalWindowDays = seed.totalWindowDays // read-only for now
  const [saving, setSaving] = useState(false)

  const handleConnectToggle = () => {
    if (connected) {
      // Disconnect must happen at the source.
      window.alert(
        `To disconnect ${connector.name}, you’ll need to remove Entwin from ${sourceSettingsLabel(connector)}. ` +
          `Revoking access there stops all future ingestion.`,
      )
      setConnected(false)
      setShowDisclaimer(true)
      // Persist + propagate the disconnect so the grid card and the DB agree.
      onConnectChange(false)
      return
    }
    // Connect → brief "Checking…" then resolve.
    setChecking(true)
    window.setTimeout(() => {
      setChecking(false)
      if (sourceStillActive) {
        // Access at the source is still live — flip straight back.
        setConnected(true)
        setShowDisclaimer(false)
      } else {
        // Genuinely new connection (unreachable in this build).
        setConnected(true)
        setShowDisclaimer(false)
      }
      onConnectChange(true)
    }, 700)
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
              <div className="conn-field-sub">Last read: Never</div>
            </div>
            <button type="button" className="conn-secondary-btn">
              Read Now
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
              backfill; the total ingestion window is the rolling range Entwin keeps indexed going forward.
            </div>
            <div className="conn-field-inline">
              <span className="conn-field-label">Initial ingestion (one-time backfill)</span>
              <IntegerStepper
                value={backfillDays}
                min={1}
                max={100}
                onChange={setBackfillDays}
                suffix="days"
                ariaLabel="Initial ingestion backfill in days"
              />
            </div>
            <div className="conn-field-inline">
              <span className="conn-field-label">Total ingestion window</span>
              <IntegerStepper value={totalWindowDays} min={365} max={365} readOnly suffix="days" ariaLabel="Total ingestion window in days" />
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
  const [senders, setSenders] = useState<Sender[]>(INITIAL_SENDERS)
  const [confirmed, setConfirmed] = useState(false)
  const [moveNote, setMoveNote] = useState('')
  const draggedId = useRef<string | null>(null)

  const drop = (listKey: ListKey) => {
    const id = draggedId.current
    if (!id) return
    const sender = senders.find((s) => s.id === id)
    if (sender && sender.list !== listKey) {
      const ruleKey = `${sender.list}>${listKey}`
      setMoveNote(`${sender.name}: ${MOVE_RULES[ruleKey]}`)
      setSenders((prev) => prev.map((s) => (s.id === id ? { ...s, list: listKey } : s)))
    }
    draggedId.current = null
  }

  return (
    <div className="dash-panel active" id="dash-kanban">
      {!confirmed && (
        <div className="kanban-banner" id="kanban-banner">
          <div className="kanban-banner-text">Reviewing the last 90 days from account connection. Drag any miscategorized sender to the right column before confirming.</div>
          <button className="kanban-confirm-btn" onClick={() => setConfirmed(true)}>Confirm classification</button>
        </div>
      )}
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
                {cards.map((s) => {
                  const isNew = s.isNew && !confirmed
                  return (
                    <div
                      className={`kanban-card${isNew ? ' is-new' : ''}`}
                      key={s.id}
                      draggable
                      onDragStart={(e) => {
                        draggedId.current = s.id
                        e.currentTarget.classList.add('dragging')
                      }}
                      onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
                    >
                      <div className="kanban-card-name">{s.name}</div>
                      <div className="kanban-card-email">{s.email}</div>
                      {isNew && <div className="kanban-card-new-tag">New</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className={`kanban-move-note${moveNote ? ' show' : ''}`} id="kanban-move-note">{moveNote}</div>
    </div>
  )
}

function EntitiesPanel({ entities, setEntities }: { entities: Entity[]; setEntities: React.Dispatch<React.SetStateAction<Entity[]>> }) {
  return (
    <div className="dash-panel active" id="dash-entities">
      <div className="section-heading">Pending review</div>
      <div id="entity-queue">
        {entities.length === 0 ? (
          <div className="entity-empty">No entities waiting for review.</div>
        ) : (
          entities.map((ent) => (
            <div className="entity-card-v1" key={ent.id}>
              <div className="entity-card-v1-top">
                <span className="entity-card-v1-name">{ent.name}</span>
                <span className="entity-card-v1-score">match {ent.confidence}% &rarr; {ent.candidateId}</span>
              </div>
              <div className="entity-card-v1-meta">From {ent.noteId}, flagged {ent.flaggedDate}</div>
              <div className="entity-card-v1-aliases">Aliases seen: {ent.aliases}</div>
              <div className="entity-card-v1-actions">
                <button className="entity-card-v1-btn approve" onClick={() => setEntities((p) => p.filter((e) => e.id !== ent.id))}>Merge into {ent.candidateId}</button>
                <button className="entity-card-v1-btn" onClick={() => setEntities((p) => p.filter((e) => e.id !== ent.id))}>Create as new entity</button>
                <button className="entity-card-v1-btn reject" onClick={() => setEntities((p) => p.filter((e) => e.id !== ent.id))}>Reject</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

interface Usage { inputTokens: number; outputTokens: number; calls: number; byKind: Record<string, { calls: number; input: number; output: number }> }

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
          <div className="stat-value">0</div>
          <div className="stat-label">Notes indexed</div>
          <div className="stat-sub">Placeholder — future ingestion metric.</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">0</div>
          <div className="stat-label">Preferences learned</div>
          <div className="stat-sub">Placeholder — future personalization metric.</div>
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
          <div className="stat-value">184</div>
          <div className="stat-sub">Marketing list senders, logged to the Ignored Daily Note</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Storage tier</div>
          <div className="stat-value">42</div>
          <div className="stat-sub">Updates list senders (banks, social, transactions)</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Memory-worthy</div>
          <div className="stat-value">67</div>
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
          <div className="stat-value">12</div>
          <div className="stat-sub">Created from a clean, no-match resolution</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Appended to existing</div>
          <div className="stat-value">34</div>
          <div className="stat-sub">Memory Note References added to a known Entity file</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Open items</div>
          <div className="stat-value">7</div>
          <div className="stat-sub">Memory Notes whose action still includes await or decision</div>
        </div>
      </div>
    </div>
  )
}

function DashboardView({ connectedCount, total, entities, setEntities }: { connectedCount: number; total: number; entities: Entity[]; setEntities: React.Dispatch<React.SetStateAction<Entity[]>> }) {
  const [tab, setTab] = useState<DashTab>('overview')
  const [alertVisible, setAlertVisible] = useState(true)

  return (
    <>
      <div className="view-header">Dashboard<div className="sub">Ingestion stats, sender classification, and entity review</div></div>
      <div className="subtab-bar">
        <button className={`subtab-btn${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`subtab-btn${tab === 'kanban' ? ' active' : ''}`} onClick={() => setTab('kanban')}>Sender Kanban</button>
        <button className={`subtab-btn${tab === 'entities' ? ' active' : ''}`} onClick={() => setTab('entities')}>
          Entity Review{entities.length > 0 && <span className="subtab-badge" id="entity-badge">{entities.length}</span>}
        </button>
      </div>
      <div id="dashboard-body">
        {tab === 'overview' && <OverviewPanel connectedCount={connectedCount} total={total} alertVisible={alertVisible} dismissAlert={() => setAlertVisible(false)} />}
        {tab === 'kanban' && <KanbanPanel />}
        {tab === 'entities' && <EntitiesPanel entities={entities} setEntities={setEntities} />}
      </div>
    </>
  )
}

/* ---------------- Memory view ---------------- */

interface GraphNode { id: string; name: string; type: string; size: number; firstSeen?: string; lastSeen?: string }
interface GraphEdge { source: string; target: string; weight: number }
interface WikiSource { n: number; url: string | null; date: string | null; urgency: string | null; similarity: number }
interface WikiState { answer: string; sources: WikiSource[]; loading: boolean }

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

function refLabel(s: WikiSource): string {
  const parts: string[] = []
  if (s.date) {
    const d = new Date(s.date)
    parts.push(isNaN(d.getTime()) ? String(s.date) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
  }
  if (s.url) {
    try { parts.push(new URL(s.url).hostname.replace(/^www\./, '')) } catch { /* ignore */ }
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
                    {n.name}
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
            <strong>{selected.name}</strong>
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

function SettingsView({ entwinName, setEntwinName }: { entwinName: string; setEntwinName: (v: string) => void }) {
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
  const [configured, setConfigured] = useState<{ provider?: string; model?: string } | null>(null)
  const [saveErr, setSaveErr] = useState('')
  const [saving, setSaving] = useState(false)
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
          setConfigured({ provider: d.provider, model: d.model })
          if (d.provider) setProvider(d.provider as ProviderKey)
        }
      })
      .catch(() => {})
  }, [])

  const isSelfHosted = !!SELF_HOSTED[provider]

  const backends: { value: ProviderKey; name: string; desc?: string }[] = [
    { value: 'claude', name: 'Claude API' },
    { value: 'gemini', name: 'Gemini API' },
    { value: 'openai', name: 'Open-AI API' },
    { value: 'neocloud', name: 'Neocloud', desc: 'Self-hosted LLM, rented GPU compute.' },
    { value: 'onprem', name: 'On-prem LLM', desc: 'Self-hosted LLM, runs on your own hardware.' },
  ]

  async function handleSave() {
    setSaveErr('')
    // Self-hosted providers aren't wired to the ingestion backend yet.
    if (isSelfHosted) {
      setSaveErr('Self-hosted providers are not yet supported for ingestion. Choose Claude, Gemini, or OpenAI.')
      return
    }
    if (!apiKey || apiKey.length < 8) {
      setSaveErr('Enter a valid API key.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: selectedModel[provider], apiKey }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setSaved(true)
      setConfigured({ provider, model: selectedModel[provider] })
      setApiKey('') // clear from memory after save; key is write-only
      setTimeout(() => setSaved(false), 1800)
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="view-header">Settings</div>
      <div id="settings-body">
        <div className="settings-section">
          <div className="settings-label">Entwin identity</div>
          <div className="settings-help">Give your digital twin a name. It&apos;s used across the app, like in &quot;Memory&quot;.</div>
          <label className="field-label" htmlFor="entwin-name-input">Name your Entwin</label>
          <input type="text" className="text-input" id="entwin-name-input" placeholder="Entwin" value={entwinName} onChange={(e) => setEntwinName(e.target.value)} />
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
              <input
                type="password"
                className="text-input"
                id="api-key"
                placeholder={configured?.provider === provider ? '•••••••• (set — enter to replace)' : 'sk-ant-... / sk-... / AIza...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          {isSelfHosted && (
            <div id="endpoint-field">
              <label className="field-label" htmlFor="endpoint-input">{provider === 'neocloud' ? 'Endpoint URL' : 'Host address'}</label>
              <input type="text" className="text-input" id="endpoint-input" placeholder={provider === 'neocloud' ? 'https://your-neocloud-instance.example.com' : 'localhost:11434'} />
            </div>
          )}

          <div>
            <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
            <span className={`save-confirm${saved ? ' show' : ''}`}>Saved</span>
            {saveErr && <span className="save-confirm show" style={{ color: '#e53935' }}>{saveErr}</span>}
          </div>
        </div>
      </div>
    </>
  )
}

/* ---------------- App shell ---------------- */

const NAV: { key: ViewKey; label: string; icon: JSX.Element }[] = [
  { key: 'chat', label: 'Chat', icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg> },
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

  const [currentModel, setCurrentModel] = useState('Claude Sonnet 5')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const modelWrapRef = useRef<HTMLDivElement>(null)

  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userWrapRef = useRef<HTMLDivElement>(null)

  const [connectors, setConnectors] = useState<Connector[]>(INITIAL_CONNECTORS)
  const [gmailNotice, setGmailNotice] = useState<string | null>(null)
  const [waModalOpen, setWaModalOpen] = useState(false)
  const [entities, setEntities] = useState<Entity[]>(INITIAL_ENTITIES)
  const [entwinName, setEntwinName] = useState('')

  const connectedCount = connectors.filter((c) => c.connected).length

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
          states: Record<string, { connected: boolean; settings: ConnectorSettings }>
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
          // Kick off the async 1-year backfill (GitHub Actions worker). This is
          // fire-and-forget: it registers the account for syncing and queues the
          // ingestion job. Failure here doesn't affect the scan result already
          // shown to the user.
          fetch('/api/gmail/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: cardId }),
          }).catch(() => {
            /* non-fatal: backfill can be retried from the dashboard */
          })
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
      if (modelWrapRef.current && !modelWrapRef.current.contains(e.target as Node)) setModelMenuOpen(false)
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
        {/* CHAT */}
        <div className={`view${view === 'chat' ? ' active' : ''}`} id="view-chat">
          <div className="view-header chat-header">
            <div>Chat<div className="sub">Local placeholder — no model connected yet</div></div>
            <div className="model-picker-wrap" ref={modelWrapRef}>
              <button className="model-picker-btn" onClick={(e) => { e.stopPropagation(); setModelMenuOpen((o) => !o) }}>
                <span>{currentModel}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              <div className={`model-picker-menu${modelMenuOpen ? ' open' : ''}`}>
                {MODELS.map((m) => (
                  <button
                    className={`model-option${m.name === currentModel ? ' selected' : ''}`}
                    key={m.name}
                    onClick={() => { setCurrentModel(m.name); setModelMenuOpen(false) }}
                  >
                    <span>
                      <div className="model-option-name">{m.name}</div>
                      <div className="model-option-desc">{m.desc}</div>
                    </span>
                    <svg className="model-option-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {view === 'chat' && <ChatView currentModel={currentModel} resetKey={chatResetKey} />}
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
          <div className="view-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <span>{memoryTitle}<div className="sub">How the pieces your Entwin knows connect to each other</div></span>
            <RebuildGraphButton />
          </div>
          {view === 'memory' && <MemoryGraph />}
        </div>

        {/* SETTINGS */}
        <div className={`view${view === 'settings' ? ' active' : ''}`} id="view-settings">
          <SettingsView entwinName={entwinName} setEntwinName={setEntwinName} />
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
