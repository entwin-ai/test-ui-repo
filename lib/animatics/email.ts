/**
 * Minimal email sender for the "your video is ready" notification.
 *
 * Two zero-friction options, chosen by which env vars are set:
 *   - RESEND_API_KEY (+ ANIMATICS_EMAIL_FROM): uses the Resend HTTP API.
 *   - SMTP_URL (smtp://user:pass@host:port) (+ ANIMATICS_EMAIL_FROM): SMTP.
 *
 * Kept independent of the app's Gmail OAuth (which is read-only), so sending
 * doesn't require adding Gmail send scope. If neither is configured, we no-op
 * and report it, so the render still completes and the link is shown in-app.
 */

export interface EmailResult {
  sent: boolean
  reason?: string
}

export async function sendVideoReadyEmail(params: {
  to: string
  title: string
  driveLink: string
}): Promise<EmailResult> {
  const { to, title, driveLink } = params
  const from = process.env.ANIMATICS_EMAIL_FROM || 'Animatics <onboarding@resend.dev>'
  const subject = `Your Animatics video is ready: ${title}`
  const text =
    `Your video for "${title}" has finished rendering.\n\n` +
    `Download / view it here:\n${driveLink}\n\n` +
    `— Animatics`
  const html =
    `<p>Your video for <strong>${escapeHtml(title)}</strong> has finished rendering.</p>` +
    `<p><a href="${escapeAttr(driveLink)}">Download / view your video</a></p>` +
    `<p style="color:#667">— Animatics</p>`

  // Option 1: Resend
  const resendKey = process.env.RESEND_API_KEY
  if (resendKey) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, text, html }),
      })
      if (!r.ok) {
        const body = await r.text()
        return { sent: false, reason: `Resend ${r.status}: ${body.slice(0, 200)}` }
      }
      return { sent: true }
    } catch (e) {
      return { sent: false, reason: `Resend error: ${(e as Error).message}` }
    }
  }

  // Option 2: SMTP via a tiny dynamic import of nodemailer, if present.
  const smtpUrl = process.env.SMTP_URL
  if (smtpUrl) {
    try {
      // nodemailer is optional; only imported when SMTP is configured. The
      // indirection keeps TypeScript from requiring the dependency at build.
      const modName = 'nodemailer'
      const nodemailer = (await import(/* webpackIgnore: true */ modName).catch(
        () => null,
      )) as { createTransport: (url: string) => { sendMail: (o: unknown) => Promise<unknown> } } | null
      if (!nodemailer) {
        return { sent: false, reason: 'SMTP_URL set but nodemailer is not installed.' }
      }
      const transport = nodemailer.createTransport(smtpUrl)
      await transport.sendMail({ from, to, subject, text, html })
      return { sent: true }
    } catch (e) {
      return { sent: false, reason: `SMTP error: ${(e as Error).message}` }
    }
  }

  return { sent: false, reason: 'No email transport configured (set RESEND_API_KEY or SMTP_URL).' }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
