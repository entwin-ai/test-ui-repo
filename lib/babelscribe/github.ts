/**
 * Babelscribe ⇄ GitHub Actions helpers.
 *
 * The transcribe workflow is fired via `dispatchWorkflow` (see the dispatch
 * route). GitHub's dispatch API does NOT return the created run's id, so we
 * correlate the app's `run_id` with the run through the workflow's `run-name`,
 * which embeds it:
 *
 *   run-name: babelscribe · <email> · <run_id>
 *
 * We poll the runs list for a `display_title` containing that run_id, then read
 * live progress from the run's jobs (the currently-running step name), and once
 * the run finishes we hand back the transcript.pdf artifact bytes (GitHub packs
 * artifacts as a zip; we unzip in-process and pull out transcript.pdf).
 */

import { unzipSync } from 'fflate'

const GH_API = 'https://api.github.com'

function repo(): string | null {
  return process.env.GH_REPO || null
}
function token(): string | null {
  // Reuse the same token the dispatch path uses. It needs `actions:read`
  // (public_repo / repo scope covers it) to list runs, jobs, and artifacts.
  return process.env.GH_DISPATCH_TOKEN || null
}

export function ghConfigured(): boolean {
  return Boolean(repo() && token())
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers || {}),
    },
  })
}

export type RunStatus = 'queued' | 'in_progress' | 'completed'
export type RunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'stale'
  | null

export interface BabelRunState {
  /** Whether a matching run has been located yet. */
  found: boolean
  /** Numeric GitHub run id, once located. */
  runId?: number
  /** Web URL to the run page. */
  htmlUrl?: string
  /** Coarse lifecycle status of the run. */
  status?: RunStatus
  /** Final conclusion once completed (success/failure/…). */
  conclusion?: RunConclusion
  /**
   * Human-friendly current activity — the name of the step that is currently
   * running (e.g. "Transcribe + translate"), or the last completed step, or a
   * lifecycle word like "Queued" when no step has started yet.
   */
  phaseLabel: string
  /** True once transcript.pdf is available to download. */
  artifactReady: boolean
}

interface WorkflowRun {
  id: number
  html_url: string
  status: RunStatus
  conclusion: RunConclusion
  display_title?: string
  name?: string
  created_at: string
}

interface JobStep {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: RunConclusion
  number: number
}

interface Job {
  id: number
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: RunConclusion
  steps?: JobStep[]
}

/** Find the workflow run whose display title carries this app run_id. */
async function findRun(appRunId: string): Promise<WorkflowRun | null> {
  const r = repo()
  if (!r) return null
  // The most recent runs of just this workflow — cheap and scoped.
  const res = await ghFetch(
    `/repos/${r}/actions/workflows/babelscribe-transcribe.yml/runs?per_page=30`,
  )
  if (!res.ok) return null
  const data = (await res.json()) as { workflow_runs?: WorkflowRun[] }
  const runs = data.workflow_runs || []
  const needle = appRunId.toLowerCase()
  const match = runs.find((run) =>
    `${run.display_title || ''} ${run.name || ''}`.toLowerCase().includes(needle),
  )
  return match || null
}

/** Turn a run + its jobs into a friendly current-activity label. */
function derivePhaseLabel(run: WorkflowRun, steps: JobStep[]): string {
  if (run.status === 'queued') return 'Queued'
  // Prefer the step that is actively running.
  const running = steps.find((s) => s.status === 'in_progress')
  if (running) return running.name
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'Completed'
    if (run.conclusion === 'cancelled') return 'Cancelled'
    if (run.conclusion === 'timed_out') return 'Timed out'
    return 'Failed'
  }
  // In progress but between steps — show the last completed step.
  const done = [...steps].filter((s) => s.status === 'completed').pop()
  if (done) return done.name
  return 'Starting up'
}

/** Does this completed run have the transcript artifact uploaded? */
async function artifactExists(runId: number): Promise<boolean> {
  const r = repo()
  if (!r) return false
  const res = await ghFetch(`/repos/${r}/actions/runs/${runId}/artifacts`)
  if (!res.ok) return false
  const data = (await res.json()) as { artifacts?: { name: string; expired: boolean }[] }
  return (data.artifacts || []).some(
    (a) => a.name.startsWith('babelscribe-transcript-') && !a.expired,
  )
}

/**
 * Poll the current state of a babelscribe run given the app's run_id.
 * Returns { found: false } until the run appears in the API (dispatch → run
 * creation has a short lag).
 */
export async function getRunState(appRunId: string): Promise<BabelRunState> {
  const run = await findRun(appRunId)
  if (!run) return { found: false, phaseLabel: 'Queued', artifactReady: false }

  const r = repo()!
  let steps: JobStep[] = []
  const jobsRes = await ghFetch(`/repos/${r}/actions/runs/${run.id}/jobs`)
  if (jobsRes.ok) {
    const jobsData = (await jobsRes.json()) as { jobs?: Job[] }
    steps = (jobsData.jobs || []).flatMap((j) => j.steps || [])
  }

  const phaseLabel = derivePhaseLabel(run, steps)

  let artifactReady = false
  if (run.status === 'completed' && run.conclusion === 'success') {
    artifactReady = await artifactExists(run.id)
  }

  return {
    found: true,
    runId: run.id,
    htmlUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
    phaseLabel,
    artifactReady,
  }
}

/**
 * Download the transcript.pdf for a run identified by the app's run_id.
 * GitHub serves artifacts as a zip; we fetch it, unzip in memory, and return
 * the transcript.pdf bytes. Returns null if not found/ready.
 */
export async function getTranscriptPdf(
  appRunId: string,
): Promise<{ bytes: Buffer; filename: string } | null> {
  const r = repo()
  if (!r) return null

  const run = await findRun(appRunId)
  if (!run || run.status !== 'completed') return null

  const listRes = await ghFetch(`/repos/${r}/actions/runs/${run.id}/artifacts`)
  if (!listRes.ok) return null
  const listData = (await listRes.json()) as {
    artifacts?: { id: number; name: string; expired: boolean }[]
  }
  const artifact = (listData.artifacts || []).find(
    (a) => a.name.startsWith('babelscribe-transcript-') && !a.expired,
  )
  if (!artifact) return null

  // The zip download endpoint 302-redirects to a signed URL; fetch follows it.
  const zipRes = await ghFetch(`/repos/${r}/actions/artifacts/${artifact.id}/zip`)
  if (!zipRes.ok) return null
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer())

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zipBytes)
  } catch {
    return null
  }

  // Find transcript.pdf anywhere in the artifact tree (the workflow uploads the
  // whole out/ directory, so it may be nested), falling back to any PDF.
  const names = Object.keys(files)
  const key =
    names.find((n) => /(?:^|\/)transcript\.pdf$/i.test(n)) ||
    names.find((n) => /\.pdf$/i.test(n))
  if (!key) return null

  return { bytes: Buffer.from(files[key]), filename: 'transcript.pdf' }
}
