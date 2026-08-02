// Split a long text into overlapping chunks for embedding. Emails vary wildly
// in length; a single embedding of a long body loses detail (the vector gets
// "averaged out"), so we window the body and embed each piece. Overlap keeps a
// fact that straddles a boundary retrievable from at least one chunk.
//
// Sizes are in characters (a cheap proxy for tokens — roughly 4 chars/token).
// ~2800 chars ≈ 700 tokens per chunk, comfortably inside every provider's
// embedding input limit, with 300 chars of overlap.

const CHUNK_SIZE = 2800;
const OVERLAP = 300;

export function chunkText(body, { size = CHUNK_SIZE, overlap = OVERLAP } = {}) {
  const text = (body || '').trim();
  if (!text) return [];
  if (text.length <= size) return [text];

  // Prefer to break on paragraph, then sentence, then hard cut — so chunks end
  // at natural boundaries instead of mid-word where possible.
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const para = slice.lastIndexOf('\n\n');
      const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const breakAt = para > size * 0.5 ? para : sentence > size * 0.5 ? sentence + 1 : -1;
      if (breakAt > 0) end = start + breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlap; // step back for overlap
    if (start < 0) start = 0;
  }
  return chunks.filter((c) => c.length > 0);
}
