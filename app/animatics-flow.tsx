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

export default function AnimaticsFlow({ onClose }: { onClose: () => void }) {
  const [job, setJob] = useState<JobState | null>(null)
  const [step, setStep] = useState<Step>('upload')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsKey, setNeedsKey] = useState(false)
  const [editedProse, setEditedProse] = useState<string>('')
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
      const d = await r.json()
      if (!r.ok) {
        setError(d.error || 'Upload failed.')
        if (d.needsKey) setNeedsKey(true)
        return
      }
      setJob({
        id: d.jobId,
        status: d.status,
        characters: d.characters,
        hasScreenplay: false,
        screenplayProse: null,
        shotCount: 0,
        parseStats: d.parseStats,
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
      const form = new FormData()
      form.append('jobId', job.id)
      form.append('characterId', characterId)
      form.append('image', file)
      const r = await fetch('/api/animatics/headshot', { method: 'POST', body: form })
      const d = await r.json()
      if (!r.ok) {
        setError(d.error || 'Headshot upload failed.')
        return
      }
      await refreshStatus(job.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const allHeadshots = !!job && job.characters.length > 0 && job.characters.every((c) => c.hasHeadshot)

  // Step 3 — generate the screenplay.
  async function generate() {
    if (!job) return
    setError(null)
    setNeedsKey(false)
    setBusy(true)
    try {
      const r = await fetch('/api/animatics/screenplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      })
      const d = await r.json()
      if (!r.ok) {
        setError(d.error || 'Screenplay generation failed.')
        if (d.needsKey) setNeedsKey(true)
        return
      }
      const updated = await refreshStatus(job.id)
      setStep('screenplay')
      if (updated?.screenplayProse) setEditedProse(updated.screenplayProse)
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
      const d = await r.json()
      if (!r.ok) setError(d.error || 'Could not save edits.')
      else await refreshStatus(job.id)
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
      const d = await r.json()
      if (!r.ok) {
        setError(d.error || 'Approval failed.')
        return
      }
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
                {busy ? 'Generating screenplay…' : 'Generate screenplay'}
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
