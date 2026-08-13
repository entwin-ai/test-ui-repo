// ============================================================================
// Natural-language date-range extraction for RAG queries.
//
// Vector + keyword retrieval has no notion of an explicit date bound. When a
// user asks for "outstanding tasks since 1st August" they mean: *exclude*
// anything dated before that. Relying on the LLM to filter in-prompt is
// unreliable — it only sees the top-K retrieved rows and does fuzzy string
// date comparison. So we parse an explicit {from, to} window here and push it
// into the SQL RPC, where the filter is exact and cheap.
//
// This is deliberately dependency-free and covers the common phrasings:
//   "since 1st August", "since Aug 1 2025", "after 2025-08-01",
//   "before September", "until 15 Sept", "in July", "last 2 weeks",
//   "past 3 days", "last month", "this week", "between 1 Aug and 15 Aug",
//   "yesterday", "today", "tomorrow", "next week", "next month",
//   "next 3 days", "this weekend".
// Anything it can't parse returns nulls, and retrieval behaves exactly as
// before (undated).
//
// IMPORTANT: relative temporal words ("tomorrow", "yesterday", "next week")
// must NOT leak into the keyword-search arm — otherwise a query like "action
// items for tomorrow" keyword-matches every historical note that literally
// contains the word "tomorrow". So we also return `matched`: the exact
// substring(s) of the question that expressed the date bound, which the caller
// strips out of the text handed to the keyword search.
// ============================================================================

export interface DateRange {
  from: string | null // inclusive YYYY-MM-DD, or null for open-ended
  to: string | null // inclusive YYYY-MM-DD, or null for open-ended
  label: string | null // human-readable window, echoed back to the user
  // The literal substring of the question that expressed the temporal bound
  // (e.g. "tomorrow", "next week", "since 1st august"). Null when no bound was
  // found. Callers strip this from the keyword-search text so relative date
  // words don't match historical notes by keyword.
  matched: string | null
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function fmt(d: Date): string {
  return d.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// Resolve a bare month (no year) to a year. Direction disambiguates a
// future-looking month:
//   'past'   — the most recent occurrence not in the future ("in July" in Aug
//              2025 → July 2025). Used for since/after/in windows.
//   'future' — the nearest upcoming occurrence, staying in the current year
//              when the month is still ahead ("before September" in Aug 2025 →
//              Sept 2025, not 2024). Used for before/until bounds.
function resolveYear(month: number, now: Date, direction: 'past' | 'future' = 'past'): number {
  const y = now.getUTCFullYear()
  if (direction === 'future') return y // nearest upcoming/current-year occurrence
  return month > now.getUTCMonth() ? y - 1 : y
}

// Parse a single "1st August", "Aug 1 2025", "2025-08-01", "1/8/2025" style
// date fragment into a Date (UTC midnight). Returns null if it can't.
// `direction` only affects bare-month resolution when no year is given.
function parseDateFragment(raw: string, now: Date, direction: 'past' | 'future' = 'past'): Date | null {
  const s = raw.trim().toLowerCase()

  // ISO: 2025-08-01
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))

  // "1st August 2025" / "1 aug" / "august 1, 2025" / "aug 1"
  // day-first
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/)
  if (m && MONTHS[m[2]] !== undefined) {
    const month = MONTHS[m[2]]
    const year = m[3] ? +m[3] : resolveYear(month, now, direction)
    return new Date(Date.UTC(year, month, +m[1]))
  }
  // month-first
  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/)
  if (m && MONTHS[m[1]] !== undefined) {
    const month = MONTHS[m[1]]
    const year = m[3] ? +m[3] : resolveYear(month, now, direction)
    return new Date(Date.UTC(year, month, +m[2]))
  }

  // bare month name → first of that month
  if (MONTHS[s] !== undefined) {
    const month = MONTHS[s]
    return new Date(Date.UTC(resolveYear(month, now, direction), month, 1))
  }

  return null
}

function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0))
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + n)
  return r
}

// Resolve a bare day fragment ("15th", "15") by borrowing the month and year
// from an already-parsed sibling date. Used for "between 15th and 20th August",
// where only one side names the month. Returns null if `raw` isn't a bare day.
function borrowDay(raw: string, sibling: Date): Date | null {
  const dm = raw.trim().toLowerCase().match(/^(\d{1,2})(?:st|nd|rd|th)?$/)
  if (!dm) return null
  return new Date(Date.UTC(sibling.getUTCFullYear(), sibling.getUTCMonth(), +dm[1]))
}

/**
 * Extract an explicit date window from a free-text question. Returns nulls when
 * no temporal bound is present, in which case retrieval is unbounded as before.
 * `now` is injectable for testing; defaults to the current date.
 *
 * The order of checks matters: more specific / compound phrasings are tested
 * before the bare single-word ones ("next week" before "week", "tomorrow"
 * standalone last among the day words) so the longest expression wins and is
 * the one recorded in `matched`.
 */
export function extractDateRange(question: string, now: Date = new Date()): DateRange {
  const q = question.toLowerCase()
  const none: DateRange = { from: null, to: null, label: null, matched: null }

  // Normalise `now` to a UTC-midnight anchor so day arithmetic is stable
  // regardless of the wall-clock time embedded in the incoming Date.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  // --- between X and Y ------------------------------------------------------
  let m = q.match(
    /\bbetween\s+(.+?)\s+(?:and|to|-)\s+(.+?)(?:[.?!,]|$)/,
  )
  if (m) {
    let a = parseDateFragment(m[1], now)
    let b = parseDateFragment(m[2], now)
    // "between 15th and 20th August": one side is a bare day ("15th") with no
    // month of its own — borrow the month and year from the dated sibling so
    // the shorthand resolves instead of dropping the whole bound.
    if (a && !b) b = borrowDay(m[2], a)
    else if (!a && b) a = borrowDay(m[1], b)
    if (a && b) {
      const lo = a <= b ? a : b
      const hi = a <= b ? b : a
      return { from: iso(lo), to: iso(hi), label: `${fmt(lo)} – ${fmt(hi)}`, matched: m[0].trim() }
    }
  }

  // --- relative FUTURE windows: next/coming/upcoming N days|weeks|months -----
  m = q.match(/\b(?:next|coming|upcoming|following|in)\s+(\d+)\s+(day|week|month)s?\b/)
  if (m) {
    const n = +m[1]
    const unit = m[2]
    let to = new Date(today)
    if (unit === 'day') to = addDays(today, n)
    else if (unit === 'week') to = addDays(today, n * 7)
    else to.setUTCMonth(to.getUTCMonth() + n)
    return {
      from: iso(today),
      to: iso(to),
      label: `the next ${n} ${unit}${n === 1 ? '' : 's'}`,
      matched: m[0].trim(),
    }
  }

  // --- relative PAST windows: last/past N days|weeks|months -----------------
  m = q.match(/\b(?:last|past|previous)\s+(\d+)\s+(day|week|month)s?\b/)
  if (m) {
    const n = +m[1]
    const unit = m[2]
    const from = new Date(today)
    if (unit === 'day') from.setUTCDate(from.getUTCDate() - n)
    else if (unit === 'week') from.setUTCDate(from.getUTCDate() - n * 7)
    else from.setUTCMonth(from.getUTCMonth() - n)
    return {
      from: iso(from),
      to: iso(today),
      label: `the last ${n} ${unit}${n === 1 ? '' : 's'}`,
      matched: m[0].trim(),
    }
  }

  // --- next week / next month -----------------------------------------------
  // "next week" = the coming Sunday-Saturday block after the current week.
  if (/\bnext week\b/.test(q)) {
    const start = addDays(today, 7 - today.getUTCDay()) // upcoming Sunday
    const end = addDays(start, 6)
    return { from: iso(start), to: iso(end), label: 'next week', matched: 'next week' }
  }
  if (/\bnext month\b/.test(q)) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    const end = endOfMonth(start.getUTCFullYear(), start.getUTCMonth())
    return { from: iso(start), to: iso(end), label: 'next month', matched: 'next month' }
  }

  // --- this / next weekend --------------------------------------------------
  // Weekend = upcoming Saturday + Sunday. "this weekend" and "next weekend" are
  // treated the same (the nearest upcoming one) — good enough for task scoping.
  if (/\b(?:this|next|the|upcoming)\s+weekend\b/.test(q) || /\bweekend\b/.test(q)) {
    const dow = today.getUTCDay() // 0 Sun .. 6 Sat
    const daysToSat = (6 - dow + 7) % 7 // 0 if today is Saturday
    const sat = addDays(today, daysToSat)
    const sun = addDays(sat, 1)
    const wm = q.match(/\b(?:this|next|the|upcoming)\s+weekend\b/) || q.match(/\bweekend\b/)
    return { from: iso(sat), to: iso(sun), label: 'this weekend', matched: wm![0].trim() }
  }

  // --- last/this week|month -------------------------------------------------
  if (/\bthis week\b/.test(q)) {
    const from = new Date(today)
    from.setUTCDate(from.getUTCDate() - from.getUTCDay()) // back to Sunday
    const to = addDays(from, 6)
    return { from: iso(from), to: iso(to), label: 'this week', matched: 'this week' }
  }
  if (/\blast week\b/.test(q)) {
    const start = new Date(today)
    start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7)
    const end = addDays(start, 6)
    return { from: iso(start), to: iso(end), label: 'last week', matched: 'last week' }
  }
  if (/\bthis month\b/.test(q)) {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const to = endOfMonth(today.getUTCFullYear(), today.getUTCMonth())
    return { from: iso(from), to: iso(to), label: 'this month', matched: 'this month' }
  }
  if (/\blast month\b/.test(q)) {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
    const to = endOfMonth(today.getUTCFullYear(), today.getUTCMonth() - 1)
    return { from: iso(from), to: iso(to), label: 'last month', matched: 'last month' }
  }

  // --- tomorrow / today / yesterday -----------------------------------------
  // Checked after the multi-word phrases above so "next week" etc. win first.
  if (/\btomorrow\b/.test(q)) {
    const d = addDays(today, 1)
    return { from: iso(d), to: iso(d), label: 'tomorrow', matched: 'tomorrow' }
  }
  if (/\btoday\b/.test(q)) {
    return { from: iso(today), to: iso(today), label: 'today', matched: 'today' }
  }
  if (/\byesterday\b/.test(q)) {
    const d = addDays(today, -1)
    return { from: iso(d), to: iso(d), label: 'yesterday', matched: 'yesterday' }
  }

  // --- since / after / from X ----------------------------------------------
  m = q.match(/\b(?:since|after|from|starting)\s+(.+?)(?:[.?!,]|$)/)
  if (m) {
    const d = parseDateFragment(m[1], now)
    if (d) return { from: iso(d), to: null, label: `since ${fmt(d)}`, matched: m[0].trim() }
  }

  // --- before / until / up to X --------------------------------------------
  m = q.match(/\b(?:before|until|till|up to|by)\s+(.+?)(?:[.?!,]|$)/)
  if (m) {
    const d = parseDateFragment(m[1], now, 'future')
    if (d) return { from: null, to: iso(d), label: `before ${fmt(d)}`, matched: m[0].trim() }
  }

  // --- "in <month>" → whole month ------------------------------------------
  m = q.match(/\bin\s+([a-z]+)\.?(?:\s+(\d{4}))?\b/)
  if (m && MONTHS[m[1]] !== undefined) {
    const month = MONTHS[m[1]]
    const year = m[2] ? +m[2] : resolveYear(month, now)
    const from = new Date(Date.UTC(year, month, 1))
    const to = endOfMonth(year, month)
    return { from: iso(from), to: iso(to), label: fmt(from).replace(/^1 /, '') + ' (month)', matched: m[0].trim() }
  }

  return none
}

/**
 * Remove the temporal expression (`range.matched`) from a question so it does
 * not pollute the keyword-search arm. Relative words like "tomorrow" / "next
 * week" carry no lexical retrieval value — they only match historical notes
 * that happen to contain the same word — so once we've turned them into an
 * explicit {from,to} bound, we drop them from the keyword text. The full
 * question is still used for the semantic embedding, so intent is preserved.
 *
 * Also strips now-dangling connective words left behind ("for", "pending for",
 * trailing prepositions) and collapses whitespace. Never returns an empty
 * string: if stripping would remove everything, the original question is kept.
 */
export function stripDateExpression(question: string, range: DateRange): string {
  if (!range.matched) return question
  // Escape regex metacharacters in the matched phrase.
  const esc = range.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Also swallow a directly preceding connective ("for", "due", "scheduled for",
  // "on", "this") so "action items for tomorrow" → "action items", not
  // "action items for".
  const pattern = new RegExp(
    `\\s*\\b(?:for|due|scheduled|planned|on|pending)?\\s*${esc}\\b`,
    'ig',
  )
  let out = question.replace(pattern, ' ')
  // Tidy leftover punctuation/whitespace.
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.?!,])/g, '$1').trim()
  // Strip a trailing dangling preposition ("... pending for" → "... pending").
  out = out.replace(/\b(?:for|on|due|by|since|from|starting)\s*$/i, '').trim()
  return out.length > 0 ? out : question
}
