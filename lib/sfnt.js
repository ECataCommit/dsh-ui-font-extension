/**
 * Minimal SFNT reader for font metadata and collection splitting.
 *
 * Supports single-face sfnt (TrueType `0x00010000` and OpenType `OTTO`),
 * TrueType/OpenType collections (`ttcf`), WOFF (`wOFF`) and WOFF2 (`wOF2`).
 * It reads just enough of the `name` and `OS/2` tables to learn a face's
 * family, subfamily, weight and slant, and it can copy one face of a
 * collection into a standalone sfnt that a browser accepts — browsers do not
 * load `.ttc` files directly.
 *
 * No table is transformed: only the byte layout around the tables is
 * rebuilt, so glyph data, cmap and layout tables are copied verbatim.
 */

import { brotliDecompressSync, inflateSync } from 'node:zlib'

/** Tags WOFF2 stores by index; any other tag is written out literally. */
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ',
  'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp',
  'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF',
  'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc',
  'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
  'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]

/** Subfamily words that stand for a weight when `OS/2` is missing. */
const WEIGHT_WORDS = [
  ['thin', 100], ['hairline', 100],
  ['extralight', 200], ['ultralight', 200], ['extra light', 200], ['ultra light', 200],
  ['light', 300],
  ['book', 400], ['regular', 400], ['normal', 400], ['roman', 400],
  ['medium', 500],
  ['semibold', 600], ['demibold', 600], ['semi bold', 600], ['demi bold', 600],
  ['extrabold', 800], ['ultrabold', 800], ['extra bold', 800], ['ultra bold', 800],
  ['bold', 700],
  ['black', 900], ['heavy', 900],
]

/** Align a byte offset up to the four-byte boundary sfnt requires. */
function align4(value) {
  return (value + 3) & ~3
}

/** Sum a region as big-endian 32-bit words, the sfnt checksum rule. */
function checksumOf(buffer, offset, length) {
  let sum = 0
  const end = offset + length
  let cursor = offset
  while (cursor + 4 <= end) {
    sum = (sum + buffer.readUInt32BE(cursor)) >>> 0
    cursor += 4
  }
  if (cursor < end) {
    let tail = 0
    for (let i = 0; i < 4; i += 1) {
      tail = (tail << 8) | (cursor + i < end ? buffer[cursor + i] : 0)
    }
    sum = (sum + (tail >>> 0)) >>> 0
  }
  return sum >>> 0
}

/** Read the table of contents at `dirOffset`; entries point into the same buffer. */
function tableOfContents(buffer, dirOffset) {
  if (dirOffset + 12 > buffer.length) throw new Error('truncated offset table')
  const numTables = buffer.readUInt16BE(dirOffset + 4)
  if (numTables === 0 || numTables > 512) throw new Error(`implausible table count ${numTables}`)
  if (dirOffset + 12 + numTables * 16 > buffer.length) throw new Error('truncated table directory')
  const tables = new Map()
  for (let index = 0; index < numTables; index += 1) {
    const record = dirOffset + 12 + index * 16
    const tag = buffer.toString('latin1', record, record + 4)
    const offset = buffer.readUInt32BE(record + 8)
    const length = buffer.readUInt32BE(record + 12)
    if (length === 0 || offset + length > buffer.length) continue
    tables.set(tag, { offset, length })
  }
  return tables
}

/** Read a WOFF table directory, inflating each table that is compressed. */
function woffTableOfContents(buffer) {
  const numTables = buffer.readUInt16BE(12)
  const tables = new Map()
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20
    if (record + 20 > buffer.length) throw new Error('truncated WOFF directory')
    const tag = buffer.toString('latin1', record, record + 4)
    const offset = buffer.readUInt32BE(record + 4)
    const compressedLength = buffer.readUInt32BE(record + 8)
    const originalLength = buffer.readUInt32BE(record + 12)
    if (offset + compressedLength > buffer.length) continue
    const raw = buffer.subarray(offset, offset + compressedLength)
    tables.set(tag, compressedLength === originalLength ? Buffer.from(raw) : inflateSync(raw))
  }
  return tables
}

/** Decode one base-128 variable-length integer (WOFF2 table directory). */
function readBase128(buffer, start) {
  let value = 0
  let cursor = start
  for (let index = 0; index < 5; index += 1) {
    const byte = buffer[cursor]
    if (byte === undefined) throw new Error('truncated WOFF2 directory')
    cursor += 1
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, cursor }
  }
  throw new Error('invalid WOFF2 UIntBase128')
}

/** Read a WOFF2 table directory and decompress the single shared font data block. */
function woff2TableOfContents(buffer) {
  const numTables = buffer.readUInt16BE(12)
  const compressedSize = buffer.readUInt32BE(20)
  let cursor = 48
  const entries = []
  for (let index = 0; index < numTables; index += 1) {
    const flags = buffer[cursor]
    if (flags === undefined) throw new Error('truncated WOFF2 directory')
    cursor += 1
    const tagIndex = flags & 0x3f
    const transformVersion = (flags >> 6) & 0x03
    let tag
    if (tagIndex === 63) {
      tag = buffer.toString('latin1', cursor, cursor + 4)
      cursor += 4
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex]
    }
    const originalLength = readBase128(buffer, cursor)
    cursor = originalLength.cursor
    const transformed = (tag === 'glyf' || tag === 'loca')
      ? transformVersion === 0
      : tag === 'hmtx' ? transformVersion === 1 : false
    let length = originalLength.value
    if (transformed) {
      const transformLength = readBase128(buffer, cursor)
      cursor = transformLength.cursor
      length = transformLength.value
    }
    entries.push({ tag, length })
  }
  const data = brotliDecompressSync(buffer.subarray(cursor, cursor + compressedSize))
  const tables = new Map()
  let offset = 0
  for (const entry of entries) {
    tables.set(entry.tag, data.subarray(offset, offset + entry.length))
    offset += entry.length
  }
  return tables
}

/** Decode one `name` record according to its platform encoding. */
function decodeNameRecord(buffer, offset, length, platform) {
  if (platform === 0 || platform === 3) {
    let text = ''
    for (let cursor = offset; cursor + 1 < offset + length; cursor += 2) {
      text += String.fromCharCode(buffer.readUInt16BE(cursor))
    }
    return text
  }
  return buffer.toString('latin1', offset, offset + length)
}

/** Parse a `name` table into `{ nameId, platform, language, value }` records. */
function parseNameTable(table) {
  const count = table.readUInt16BE(2)
  const storage = table.readUInt16BE(4)
  const records = []
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12
    if (record + 12 > table.length) break
    const platform = table.readUInt16BE(record)
    const language = table.readUInt16BE(record + 4)
    const nameId = table.readUInt16BE(record + 6)
    const length = table.readUInt16BE(record + 8)
    const offset = table.readUInt16BE(record + 10)
    if (storage + offset + length > table.length) continue
    records.push({ platform, language, nameId, value: decodeNameRecord(table, storage + offset, length, platform) })
  }
  return records
}

/** Return the best available value for the first name ID that has one. */
function pickName(records, nameIds) {
  for (const nameId of nameIds) {
    const candidates = records.filter(record => record.nameId === nameId && record.value.trim() !== '')
    if (candidates.length === 0) continue
    const chosen = candidates.find(record => record.platform === 3 && record.language === 0x409)
      ?? candidates.find(record => record.platform === 3)
      ?? candidates.find(record => record.platform === 0)
      ?? candidates.find(record => record.platform === 1 && record.language === 0)
      ?? candidates[0]
    return chosen.value.trim()
  }
  return ''
}

/** Map a subfamily word to a numeric weight. */
function weightFromWords(subfamily) {
  const text = subfamily.toLowerCase()
  for (const [word, weight] of WEIGHT_WORDS) {
    if (text.includes(word)) return weight
  }
  return 400
}

/** Read weight and slant from OS/2, falling back to the subfamily name. */
function readStyle(os2Table, subfamily) {
  let weight = 0
  let italic = false
  if (os2Table !== undefined && os2Table.length >= 8) {
    weight = os2Table.readUInt16BE(4)
    if (os2Table.length >= 64) italic = (os2Table.readUInt16BE(62) & 0x0001) !== 0
  }
  if (/italic|oblique/i.test(subfamily)) italic = true
  if (weight < 1 || weight > 1000) weight = weightFromWords(subfamily)
  return { weight, italic }
}

/** Turn a table-of-contents map into tag → table bytes. */
function tableBytes(buffer, tables) {
  const bytes = new Map()
  for (const [tag, table] of tables) bytes.set(tag, buffer.subarray(table.offset, table.offset + table.length))
  return bytes
}

/** Describe one face from its tables. */
function describe(tables, fallbackFamily) {
  const nameTable = tables.get('name')
  const records = nameTable === undefined ? [] : parseNameTable(nameTable)
  const family = pickName(records, [16, 1]) || fallbackFamily
  const subfamily = pickName(records, [17, 2])
  const fullName = pickName(records, [4, 6])
  const { weight, italic } = readStyle(tables.get('OS/2'), subfamily)
  return { family, subfamily, fullName, weight, italic }
}

/** Sniff the container format of an in-memory font file. */
export function sniffContainer(buffer) {
  if (buffer.length < 12) return 'unknown'
  const signature = buffer.toString('latin1', 0, 4)
  if (signature === 'ttcf') return 'ttc'
  if (signature === 'wOFF') return 'woff'
  if (signature === 'wOF2') return 'woff2'
  if (signature === 'OTTO' || signature === 'true' || signature === 'typ1') return 'sfnt'
  if (buffer.readUInt32BE(0) === 0x00010000) return 'sfnt'
  return 'unknown'
}

/** Copy one face of a collection into a standalone sfnt buffer. */
export function extractFace(buffer, dirOffset) {
  const tables = tableOfContents(buffer, dirOffset)
  const version = buffer.readUInt32BE(dirOffset)
  const tags = [...tables.keys()].sort()
  const headerSize = 12 + tags.length * 16
  const layout = new Map()
  let cursor = headerSize
  for (const tag of tags) {
    const table = tables.get(tag)
    cursor = align4(cursor)
    layout.set(tag, { offset: cursor, length: table.length, source: table.offset })
    cursor += align4(table.length)
  }
  const out = Buffer.alloc(cursor)
  out.writeUInt32BE(version, 0)
  out.writeUInt16BE(tags.length, 4)
  const selector = Math.max(0, Math.floor(Math.log2(tags.length)))
  const searchRange = 16 * 2 ** selector
  out.writeUInt16BE(searchRange, 6)
  out.writeUInt16BE(selector, 8)
  out.writeUInt16BE(tags.length * 16 - searchRange, 10)

  const head = layout.get('head')
  if (head !== undefined) out.writeUInt32BE(0, head.offset + 8)
  let record = 12
  for (const tag of tags) {
    const entry = layout.get(tag)
    buffer.copy(out, entry.offset, entry.source, entry.source + entry.length)
    out.write(tag, record, 4, 'latin1')
    out.writeUInt32BE(checksumOf(out, entry.offset, entry.length), record + 4)
    out.writeUInt32BE(entry.offset, record + 8)
    out.writeUInt32BE(entry.length, record + 12)
    record += 16
  }
  if (head !== undefined) {
    const adjustment = (0xb1b0afba - checksumOf(out, 0, out.length)) >>> 0
    out.writeUInt32BE(adjustment, head.offset + 8)
  }
  return out
}

/**
 * Read every face a font file holds.
 * @param buffer - complete file bytes.
 * @param options - `fallbackFamily` names faces whose `name` table has no family.
 * @returns one descriptor per face; `dirOffset` is set for collection faces,
 *   which the caller hands to {@link extractFace} when the browser asks.
 */
export function readFaces(buffer, options = {}) {
  const fallbackFamily = options.fallbackFamily ?? ''
  const container = sniffContainer(buffer)
  if (container === 'unknown') return []

  if (container === 'ttc') {
    const numFonts = buffer.readUInt32BE(8)
    if (numFonts < 1 || numFonts > 512) throw new Error(`implausible collection size ${numFonts}`)
    const faces = []
    for (let index = 0; index < numFonts; index += 1) {
      const dirOffset = buffer.readUInt32BE(12 + index * 4)
      const tables = tableOfContents(buffer, dirOffset)
      const version = buffer.readUInt32BE(dirOffset)
      faces.push({
        ...describe(tableBytes(buffer, tables), fallbackFamily),
        container,
        dirOffset,
        faceIndex: index,
        faceCount: numFonts,
        format: version === 0x4f54544f ? 'opentype' : 'truetype',
      })
    }
    return faces
  }

  const tables = container === 'sfnt'
    ? tableBytes(buffer, tableOfContents(buffer, 0))
    : container === 'woff' ? woffTableOfContents(buffer) : woff2TableOfContents(buffer)
  const format = container === 'sfnt'
    ? (buffer.readUInt32BE(0) === 0x4f54544f ? 'opentype' : 'truetype')
    : container
  return [{
    ...describe(tables, fallbackFamily),
    container,
    dirOffset: 0,
    faceIndex: 0,
    faceCount: 1,
    format,
  }]
}
