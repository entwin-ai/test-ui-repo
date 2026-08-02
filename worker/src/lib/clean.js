import { convert } from 'html-to-text';
import crypto from 'crypto';

// Turn a Gmail message's parts into the NET-NEW body text: HTML->text if needed,
// strip the quoted prior-chain tail and signatures, normalise whitespace.
// (Requirements doc §2/§3.)
export function cleanBody({ text, html }) {
  let body = text && text.trim().length > 0
    ? text
    : convert(html || '', {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: false } },
          { selector: 'img', format: 'skip' },
          // gmail_quote holds the quoted tail — drop it before conversion
          { selector: 'blockquote', format: 'skip' },
          { selector: '.gmail_quote', format: 'skip' },
        ],
      });

  body = stripQuotedTail(body);
  body = stripSignature(body);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// Remove everything from the first quoted-reply marker onward.
function stripQuotedTail(body) {
  const lines = body.split('\n');
  const markers = [
    /^On .+ wrote:$/i,                       // On <date>, <person> wrote:
    /^-{2,}\s*Original Message\s*-{2,}/i,    // -----Original Message-----
    /^_{5,}$/,                               // ________
    /^From:\s.+/i,                           // forwarded header block
    /^\s*>/,                                 // quoted lines
    /^Sent from my /i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((re) => re.test(lines[i].trim()))) {
      cut = i;
      break;
    }
  }
  return lines.slice(0, cut).join('\n');
}

// Trim a trailing signature block after a `-- ` delimiter or common sign-offs.
function stripSignature(body) {
  const sigDelim = body.indexOf('\n-- \n');
  if (sigDelim !== -1) return body.slice(0, sigDelim);
  return body;
}

// Normalised content hash for near-duplicate detection.
export function contentHash(body) {
  const norm = body.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}
