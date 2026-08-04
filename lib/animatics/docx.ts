import { deflateRawSync } from 'zlib'
import { crc32 } from './crc32'

/**
 * Minimal, dependency-free .docx generator.
 *
 * A .docx is a ZIP of OOXML parts. The project has no `docx` npm package and we
 * want zero cold-start cost on Vercel, so we emit the handful of XML parts Word
 * needs and pack them with a tiny ZIP writer (below). Output opens cleanly in
 * Word, Google Docs, and LibreOffice.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Line {
  text: string
  style: 'Title' | 'Heading1' | 'Heading2' | 'Normal' | 'Dialogue'
}

/**
 * Turn screenplay prose into styled paragraphs. Recognizes SCENE headings and
 * "NAME: line" dialogue so the Word doc is readable, not a wall of text.
 */
function proseToLines(title: string, prose: string): Line[] {
  const lines: Line[] = [{ text: title, style: 'Title' }]
  for (const rawPara of prose.split(/\n/)) {
    const p = rawPara.trim()
    if (!p) continue
    if (/^scene\b/i.test(p) || /^(int\.|ext\.)/i.test(p)) {
      lines.push({ text: p, style: 'Heading1' })
    } else if (/^[A-Z][A-Z0-9 .'\-]{1,30}:/.test(p)) {
      lines.push({ text: p, style: 'Dialogue' })
    } else if (/^(chapter|part|act)\b/i.test(p)) {
      lines.push({ text: p, style: 'Heading2' })
    } else {
      lines.push({ text: p, style: 'Normal' })
    }
  }
  return lines
}

function paragraphXml(line: Line): string {
  const pStyle =
    line.style === 'Normal' ? '' : `<w:pPr><w:pStyle w:val="${line.style}"/></w:pPr>`
  return `<w:p>${pStyle}<w:r><w:t xml:space="preserve">${esc(line.text)}</w:t></w:r></w:p>`
}

function documentXml(lines: Line[]): string {
  const body = lines.map(paragraphXml).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Dialogue"><w:name w:val="Dialogue"/><w:pPr><w:ind w:left="720"/><w:spacing w:after="80"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOC_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

// --- tiny ZIP writer (deflate) -------------------------------------------

interface Entry {
  name: string
  data: Buffer
}

function zip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const compressed = deflateRawSync(e.data)
    const useDeflate = compressed.length < e.data.length
    const stored = useDeflate ? compressed : e.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, stored)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(stored.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))

    offset += local.length + nameBuf.length + stored.length
  }

  const centralBuf = Buffer.concat(central)
  const startCentral = offset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(startCentral, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, end])
}

/** Build a .docx buffer from a title and screenplay prose. */
export function buildScreenplayDocx(title: string, prose: string): Buffer {
  const lines = proseToLines(title, prose)
  const entries: Entry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(lines), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS_XML, 'utf8') },
  ]
  return zip(entries)
}
