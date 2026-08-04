/**
 * Novel text cleaner for the Animatics pipeline.
 *
 * Uploaded .txt novels are frequently "beautified" with decorative junk that
 * carries no story meaning: ASCII border lines, separator rules, box-drawing
 * frames, centered star dividers, ornaments, page markers, gutter dashes, and
 * so on. Feeding that noise to the LLM wastes tokens and pollutes character
 * extraction. This module removes the decoration and keeps the prose.
 *
 * Design principle: be aggressive about lines that are *purely* decorative,
 * but conservative about lines that contain real words. A line like
 * "******** Chapter One ********" still has meaningful content ("Chapter One"),
 * so we strip the ornament and keep the text rather than deleting the line.
 */

export interface ParseResult {
  text: string
  stats: {
    originalChars: number
    cleanedChars: number
    originalLines: number
    keptLines: number
    droppedLines: number
    strippedOrnamentLines: number
  }
}

/**
 * Characters that show up in decorative rules/frames but essentially never in
 * genuine prose. Box-drawing (U+2500–257F), block elements (U+2580–259F),
 * common ASCII rule glyphs, and a few ornament dingbats.
 */
const DECOR_CHARS =
  '=~_*#+.:<>|/\\^\u2500-\u259F\u2010-\u2015\u2022\u00B7\u2043\u2E3A\u2E3B' +
  '\u25A0-\u25FF\u2660-\u2666\u273B-\u2749\u2731\u2732\u066D\u274A\u274B\uFF0A'

// A line is "ornamental" if, after removing whitespace, ≥85% of its characters
// are decorative glyphs AND it has at least 3 such characters in a row
// somewhere (a real sentence won't have "-----" runs).
const ORNAMENT_RUN = /([=~_*#+.<>|/\\^\u2500-\u259F\u2010-\u2015\u2022\u00B7-])\1{2,}/
const DECOR_ONLY = new RegExp(`^[\\s${DECOR_CHARS}]+$`)

// Leading/trailing ornament wrapper around real text, e.g. "*** Title ***",
// "=== Chapter 1 ===", "--- scene break ---", "|  centered  |".
//
// The trailing pattern deliberately requires either a run of 2+ decorative
// glyphs or a decorative glyph that is NOT ordinary sentence punctuation, so a
// single sentence-ending "." "!" "?" is preserved. (A lone "." at end of a
// real sentence is not ornament.)
const LEAD_ORNAMENT = new RegExp(`^[\\s${DECOR_CHARS}]+`)
const TRAIL_ORNAMENT = new RegExp(
  `(?:[\\s${DECOR_CHARS}]*[${DECOR_CHARS}]{2,}[\\s${DECOR_CHARS}]*|[\\s]*[=~_*#+<>|/\\\\^\u2500-\u259F\u2022\u00B7]+[\\s${DECOR_CHARS}]*)$`,
)

// Standalone page/section markers that are noise for a screenplay.
const PAGE_MARKER =
  /^\s*(?:-\s*)?(?:page|pg\.?|p\.)\s*\d+\s*(?:of\s*\d+)?\s*-?\s*$/i
const NUMERIC_ONLY = /^\s*\d{1,4}\s*$/ // lone page numbers
const DECORATIVE_WORD_RULE = /^\s*(?:the\s+)?end\s*[.!]?\s*$/i // keep "The End"? see below

const LETTER = /\p{L}/u

/**
 * Count how many chars in a string are "meaningful" (letters or digits that sit
 * next to letters). Used to decide whether a stripped line still says anything.
 */
function meaningfulCharCount(s: string): number {
  let n = 0
  for (const ch of s) if (LETTER.test(ch)) n++
  return n
}

/**
 * Clean a single line. Returns the cleaned line, or null if the whole line is
 * decorative and should be dropped.
 */
function cleanLine(raw: string): string | null {
  // Normalize odd whitespace (non-breaking spaces, tabs) to plain spaces.
  let line = raw.replace(/[\t\u00A0\u2007\u202F]+/g, ' ').replace(/[ ]{2,}/g, ' ')

  const trimmed = line.trim()
  if (trimmed === '') return '' // preserve blank lines (paragraph breaks)

  // Pure decoration: a line made only of decorative glyphs/whitespace, or a
  // short line dominated by an ornament run with no real words.
  if (DECOR_ONLY.test(trimmed)) return null
  if (ORNAMENT_RUN.test(trimmed) && meaningfulCharCount(trimmed) === 0) return null

  // Page markers / lone page numbers.
  if (PAGE_MARKER.test(trimmed)) return null
  if (NUMERIC_ONLY.test(trimmed)) return null

  // Strip leading/trailing ornament wrappers ("*** Title ***" -> "Title"),
  // but only if what remains still contains real words.
  let stripped = trimmed.replace(LEAD_ORNAMENT, '').replace(TRAIL_ORNAMENT, '')
  if (meaningfulCharCount(stripped) === 0) {
    // Nothing meaningful survived — it was all ornament.
    return null
  }

  // Collapse any interior decorative runs of length ≥4 (e.g. a dot-leader
  // "Chapter 1 ........ 12") down, then re-trim.
  stripped = stripped.replace(/[.\-_=~*]{4,}/g, ' ').replace(/[ ]{2,}/g, ' ').trim()

  return stripped
}

/**
 * Clean an uploaded novel. Collapses 3+ consecutive blank lines to a single
 * blank line so paragraph structure survives without huge vertical gaps.
 */
export function cleanNovel(input: string): ParseResult {
  const originalChars = input.length
  // Normalize line endings.
  const normalized = input.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  const out: string[] = []
  let dropped = 0
  let strippedOrnament = 0
  let blankRun = 0

  for (const raw of lines) {
    const cleaned = cleanLine(raw)
    if (cleaned === null) {
      dropped++
      continue
    }
    if (cleaned === '') {
      blankRun++
      if (blankRun <= 1) out.push('') // keep at most one blank line in a row
      continue
    }
    blankRun = 0
    if (cleaned !== raw.trim()) strippedOrnament++
    out.push(cleaned)
  }

  // Trim leading/trailing blank lines.
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()

  const text = out.join('\n')

  return {
    text,
    stats: {
      originalChars,
      cleanedChars: text.length,
      originalLines: lines.length,
      keptLines: out.filter((l) => l !== '').length,
      droppedLines: dropped,
      strippedOrnamentLines: strippedOrnament,
    },
  }
}

/**
 * Guardrail: after cleaning, is there actually a story here? Used to reject
 * files that were all decoration or too short to animate.
 */
export function isUsableNovel(text: string): boolean {
  return meaningfulCharCount(text) >= 200
}
