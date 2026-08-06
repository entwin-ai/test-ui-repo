/**
 * Dispatch a GitHub Actions workflow, scoped to a single user (+ optional card).
 * Shared by the onboarding, sender-move backfill, and reconciliation routes so
 * the GitHub API call isn't duplicated. Returns { ok, detail }.
 */
export async function dispatchWorkflow(
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: boolean; detail?: string }> {
  const repo = process.env.GH_REPO
  const token = process.env.GH_DISPATCH_TOKEN
  if (!repo || !token) return { ok: false, detail: 'GH_REPO / GH_DISPATCH_TOKEN not configured' }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    },
  )
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => '') }
  return { ok: true }
}
