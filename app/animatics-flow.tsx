'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * Animatics Phase 1 flow, mounted as a modal over the Connectors view and
 * driven by the connector card's Connect button. Walks the user through:
 *   1. upload a .txt novel (junk stripped server-side)
 *   2. review extracted characters, upload a headshot per character
 *   3. generate the vivid screenplay (.docx to review + edit)
 *   4. approve → ready for Phase 2
 *
 * All heavy work is server-side; this component only orchestrates and shows
 * state. It resumes an in-progress job on open via /api/animatics/status.
 */

interface CharacterView {
  id: string
  name: string
  description: string
  role: string
  hasHeadshot: boolean
}

type Step = 'upload' | 'characters' | 'screenplay' | 'approved'

interface JobState {
  id: string
  status: string
  characters: CharacterView[]
  hasScreenplay: boolean
  screenplayProse: string | null
  shotCount: number
  parseStats?: Record<string, number>
  documentUrl: string | null
  error?: string | null
}

function statusToStep(job: JobState | null): Step {
  if (!job) return 'upload'
  if (job.status === 'APPROVED') return 'approved'
  if (job.status === 'AWAITING_APPROVAL' || job.hasScreenplay) return 'screenplay'
  return 'characters'
}

/**
 * Read a fetch Response safely. If the server returned a non-JSON body (e.g. a
 * platform "Request Entity Too Large" or a proxy error page), surface a clean
 * message instead of a cryptic "Unexpected token" JSON parse error.
 */
async function readResponse(
  r: Response,
): Promise<{ ok: boolean; data: Record<string, unknown>; error?: string }> {
  const text = await r.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // Non-JSON response — build a human message from status.
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim()
    const msg =
      r.status === 413
        ? 'That image is too large to upload. Please choose a smaller headshot.'
        : `Server error (${r.status})${snippet ? `: ${snippet}` : ''}`
    return { ok: false, data: {}, error: msg }
  }
  return { ok: r.ok, data, error: r.ok ? undefined : (data.error as string) }
}

/**
 * Downscale/re-encode a headshot in the browser before upload so payloads stay
 * small and well under the serverless body limit. Faces don't need to be huge —
 * 640px on the long edge is plenty to drive animation. Returns a JPEG Blob.
 */
async function downscaleImage(file: File, maxEdge = 640, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file // fallback: send original if decode fails
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return file
  ctx.drawImage(bitmap, 0, 0, w, h)
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob || file),
      'image/jpeg',
      quality,
    )
  })
}

export default function AnimaticsFlow({ onClose }: { onClose: () => void }) {
  const [job, setJob] = useState<JobState | null>(null)
  const [step, setStep] = useState<Step>('upload')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsKey, setNeedsKey] = useState(false)
  const [editedProse, setEditedProse] = useState<string>('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const headshotRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Resume any in-progress job on open.
  useEffect(() => {
    ;(async () => {
      try {
        const r = await fetch('/api/animatics/status')
        const d = await r.json()
        if (d.job) {
          setJob(d.job)
          setStep(statusToStep(d.job))
          if (d.job.screenplayProse) setEditedProse(d.job.screenplayProse)
        }
      } catch {
        /* ignore — start fresh */
      }
    })()
  }, [])

  const refreshStatus = useCallback(async (jobId: string) => {
    const r = await fetch(`/api/animatics/status?jobId=${jobId}`)
    const d = await r.json()
    if (d.job) {
      setJob(d.job)
      if (d.job.screenplayProse) setEditedProse(d.job.screenplayProse)
    }
    return d.job as JobState | null
  }, [])

  // Step 1 — upload the .txt novel.
  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setNeedsKey(false)

    if (!file.name.toLowerCase().endsWith('.txt')) {
      setError('Only .txt files are accepted. Please choose a plain-text novel.')
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    setBusy(true)
    try {
      const form = new FormData()
      form.append('story', file)
      const r = await fetch('/api/animatics/parse', { method: 'POST', body: form })
      const { ok, data: d, error: err } = await readResponse(r)
      if (!ok) {
        setError(err || 'Upload failed.')
        if (d.needsKey) setNeedsKey(true)
        return
      }
      setJob({
        id: d.jobId as string,
        status: d.status as string,
        characters: d.characters as CharacterView[],
        hasScreenplay: false,
        screenplayProse: null,
        shotCount: 0,
        parseStats: d.parseStats as Record<string, number>,
        documentUrl: null,
      })
      setStep('characters')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // Step 2 — upload a headshot for one character.
  async function onHeadshotPicked(characterId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !job) return
    setError(null)
    setBusy(true)
    try {
      // Shrink in the browser so the request stays small and never hits the
      // serverless body-size limit (the original cause of the JSON parse error).
      const scaled = await downscaleImage(file)
      const form = new FormData()
      form.append('jobId', job.id)
      form.append('characterId', characterId)
      form.append('image', scaled, 'headshot.jpg')
      const r = await fetch('/api/animatics/headshot', { method: 'POST', body: form })
      const { ok, data, error: err } = await readResponse(r)
      if (!ok) {
        setError(err || 'Headshot upload failed.')
        return
      }
      void data
      await refreshStatus(job.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      // reset the input so re-selecting the same file re-triggers change
      if (headshotRefs.current[characterId]) headshotRefs.current[characterId]!.value = ''
    }
  }

  const allHeadshots = !!job && job.characters.length > 0 && job.characters.every((c) => c.hasHeadshot)

  // Step 3 — generate the screenplay. For long/multi-episode novels this runs
  // segment-by-segment: we call the endpoint repeatedly until done:true, so the
  // WHOLE novel is adapted and no single request times out.
  async function generate() {
    if (!job) return
    setError(null)
    setNeedsKey(false)
    setBusy(true)
    setProgress(null)
    try {
      // Safety cap on iterations (segments) to avoid an infinite loop.
      for (let i = 0; i < 200; i++) {
        const r = await fetch('/api/animatics/screenplay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        })
        const { ok, data: d, error: err } = await readResponse(r)
        if (!ok) {
          setError(err || 'Screenplay generation failed.')
          if (d.needsKey) setNeedsKey(true)
          return
        }
        if (d.done) {
          setProgress(null)
          const updated = await refreshStatus(job.id)
          setStep('screenplay')
          if (updated?.screenplayProse) setEditedProse(updated.screenplayProse)
          return
        }
        // Not done — show progress and continue with the next segment.
        const doneN = Number(d.doneSegments) || 0
        const totalN = Number(d.totalSegments) || 0
        setProgress({ done: doneN, total: totalN })
      }
      setError('Generation is taking unusually long. Please try again to resume.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Step 3b — save edits (rebuilds the .docx).
  async function saveEdits() {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/animatics/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, prose: editedProse }),
      })
      const { ok, data: d, error: err } = await readResponse(r)
      if (!ok) setError(err || 'Could not save edits.')
      else {
        void d
        await refreshStatus(job.id)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Step 4 — approve.
  async function approve() {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/animatics/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, editedProse }),
      })
      const { ok, data: d, error: err } = await readResponse(r)
      if (!ok) {
        setError(err || 'Approval failed.')
        return
      }
      void d
      await refreshStatus(job.id)
      setStep('approved')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animatics-overlay" onClick={onClose}>
      <div className="animatics-modal" onClick={(e) => e.stopPropagation()}>
        <div className="animatics-header">
          <div className="animatics-title">Animatics — Create Anime from your Novel</div>
          <button className="animatics-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="animatics-steps">
          {(['upload', 'characters', 'screenplay', 'approved'] as Step[]).map((s, i) => (
            <div
              key={s}
              className={`animatics-step-dot ${step === s ? 'active' : ''} ${
                ['upload', 'characters', 'screenplay', 'approved'].indexOf(step) > i ? 'done' : ''
              }`}
            >
              <span>{i + 1}</span>
              {['Novel', 'Cast', 'Screenplay', 'Done'][i]}
            </div>
          ))}
        </div>

        <div className="animatics-body">
          {error && (
            <div className="animatics-error">
              {error}
              {needsKey && (
                <>
                  {' '}
                  Add one under <strong>Settings → LLM</strong> and try again.
                </>
              )}
            </div>
          )}

          {step === 'upload' && (
            <div className="animatics-upload">
              <p className="animatics-lead">
                Upload your novel as a plain <code>.txt</code> file. Decorative characters
                (border lines, separators, page markers) are stripped automatically — only the
                real story is used.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                style={{ display: 'none' }}
                onChange={onFilePicked}
              />
              <button
                className="animatics-primary"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'Reading…' : 'Browse for a .txt novel'}
              </button>
            </div>
          )}

          {step === 'characters' && job && (
            <div className="animatics-characters">
              <p className="animatics-lead">
                Found {job.characters.length} character
                {job.characters.length === 1 ? '' : 's'}. Upload a headshot for each — these exact
                faces drive the animation.
              </p>
              <div className="animatics-char-grid">
                {job.characters.map((c) => (
                  <div key={c.id} className={`animatics-char ${c.hasHeadshot ? 'ready' : ''}`}>
                    <div className="animatics-char-name">
                      {c.name} <span className="animatics-role">{c.role}</span>
                    </div>
                    <div className="animatics-char-desc">{c.description}</div>
                    <input
                      ref={(el) => {
                        headshotRefs.current[c.id] = el
                      }}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => onHeadshotPicked(c.id, e)}
                    />
                    <button
                      className="animatics-secondary"
                      disabled={busy}
                      onClick={() => headshotRefs.current[c.id]?.click()}
                    >
                      {c.hasHeadshot ? '✓ Headshot set — replace' : 'Upload headshot'}
                    </button>
                  </div>
                ))}
              </div>
              <button className="animatics-primary" disabled={!allHeadshots || busy} onClick={generate}>
                {busy
                  ? progress && progress.total > 1
                    ? `Generating… part ${progress.done}/${progress.total}`
                    : 'Generating screenplay…'
                  : 'Generate screenplay'}
              </button>
              {!allHeadshots && (
                <div className="animatics-hint">Upload every headshot to continue.</div>
              )}
            </div>
          )}

          {step === 'screenplay' && job && (
            <div className="animatics-screenplay">
              <p className="animatics-lead">
                Your screenplay is ready ({job.shotCount} shots). Download the Word file to read
                it, or edit the text below. Approve when you&apos;re happy.
              </p>
              <div className="animatics-actions-row">
                {job.documentUrl && (
                  <a className="animatics-secondary" href={job.documentUrl}>
                    Download .docx
                  </a>
                )}
                <button className="animatics-secondary" disabled={busy} onClick={saveEdits}>
                  {busy ? 'Saving…' : 'Save edits'}
                </button>
              </div>
              <textarea
                className="animatics-editor"
                value={editedProse}
                onChange={(e) => setEditedProse(e.target.value)}
                spellCheck={false}
              />
              <button className="animatics-primary" disabled={busy} onClick={approve}>
                {busy ? 'Approving…' : 'Approve screenplay'}
              </button>
            </div>
          )}

          {step === 'approved' && job && (
            <div className="animatics-done">
              <div className="animatics-check">✓</div>
              <p className="animatics-lead">
                Screenplay approved with {job.shotCount} shots. This is ready for the Phase 2 video
                pipeline.
              </p>
              <button className="animatics-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
