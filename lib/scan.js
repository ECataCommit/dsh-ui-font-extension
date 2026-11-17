/**
 * Directory scanner for local font files.
 *
 * The scan is synchronous on purpose: the Harness asks for the injected CSS
 * while it renders the page shell, and a directory of a few dozen files costs
 * less than a millisecond once the parsed metadata is cached by size and
 * modification time. Nothing in a request ever reaches the file system as a
 * path — the route resolves an opaque map key that this module built from a
 * directory listing, so `..` segments cannot escape anywhere.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { extractFace, readFaces } from './sfnt.js'

/** File extensions the scanner reads. */
const SUPPORTED = new Map([
  ['.woff2', { contentType: 'font/woff2', formatHint: 'woff2' }],
  ['.woff', { contentType: 'font/woff', formatHint: 'woff' }],
  ['.ttf', { contentType: 'font/ttf', formatHint: 'truetype' }],
  ['.otf', { contentType: 'font/otf', formatHint: 'opentype' }],
  ['.ttc', { contentType: 'font/ttf', formatHint: 'truetype' }],
  ['.otc', { contentType: 'font/otf', formatHint: 'opentype' }],
])

/** How many extracted collection faces stay in memory at once. */
const EXTRACTED_CACHE_SIZE = 3

/** Weight and style words dropped from a file name used as a family fallback. */
const DECORATIVE_WORDS = new Set([
  'thin', 'hairline', 'extralight', 'ultralight', 'light', 'book', 'regular', 'normal', 'roman',
  'medium', 'semibold', 'demibold', 'bold', 'extrabold', 'ultrabold', 'black', 'heavy',
  'italic', 'oblique', 'condensed', 'expanded', 'narrow', 'wide', 'variable',
])

/** Expand a leading `~` and resolve a directory to an absolute path. */
export function expandDirectory(directory) {
  const trimmed = directory.trim()
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  return resolve(expanded)
}

/** Turn a file name into a presentable family name for fonts without a `name` table. */
function familyFromFileName(fileName) {
  const stem = basename(fileName, extname(fileName))
  const words = stem.split(/[-_\s]+/).filter(word => word !== '' && !DECORATIVE_WORDS.has(word.toLowerCase()))
  const kept = words.length > 0 ? words : stem.split(/[-_\s]+/).filter(Boolean)
  return kept
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Percent-encode one URL path segment, keeping it usable inside a CSS url(). */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Build a scanner over a set of font directories.
 * @param options - `dirs`, `maxFileBytes`, and a `log(level, message)` sink.
 * @returns `scan()`, `lookup(urlPath)`, and `read(entry)`.
 */
export function createScanner(options) {
  const dirs = options.dirs
  const maxFileBytes = options.maxFileBytes
  const log = options.log ?? (() => {})

  /** Parsed metadata per absolute path, keyed by size and modification time. */
  const parsed = new Map()
  /** Extracted collection faces, oldest first. */
  const extracted = new Map()
  /** One warning per distinct message, so a render loop cannot flood the log. */
  const warned = new Set()

  let entries = []
  let byPath = new Map()

  function warnOnce(message) {
    if (warned.has(message)) return
    warned.add(message)
    log('warn', `[dsh-ui-font-extension] ${message}`)
  }

  function readFacesForFile(filePath, size, mtimeMs) {
    const key = `${filePath}\u0000${size}\u0000${mtimeMs}`
    const cached = parsed.get(filePath)
    if (cached !== undefined && cached.key === key) return cached.faces
    const buffer = readFileSyncSafe(filePath)
    if (buffer === null) return []
    if (buffer.length > maxFileBytes) {
      warnOnce(`${filePath} is larger than maxFileBytes (${maxFileBytes}); skipped`)
      return []
    }
    let faces
    try {
      faces = readFaces(buffer, { fallbackFamily: familyFromFileName(filePath) })
    } catch (error) {
      warnOnce(`${filePath} could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    parsed.set(filePath, { key, faces })
    return faces
  }

  function scan() {
    const next = []
    const nextByPath = new Map()
    for (const rawDirectory of dirs) {
      const directory = expandDirectory(rawDirectory)
      let dirents
      try {
        dirents = readdirSync(directory, { withFileTypes: true })
      } catch (error) {
        warnOnce(`font directory ${directory} is not readable: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const dirent of dirents) {
        const fileName = dirent.name
        if (fileName.startsWith('.')) continue
        const descriptor = SUPPORTED.get(extname(fileName).toLowerCase())
        if (descriptor === undefined) continue
        const filePath = join(directory, fileName)
        let stats
        try {
          stats = statSync(filePath)
        } catch {
          continue
        }
        if (!stats.isFile()) continue
        const faces = readFacesForFile(filePath, stats.size, stats.mtimeMs)
        if (faces.length === 0) continue
        const rev = createHash('sha1').update(`${stats.size}:${stats.mtimeMs}`).digest('hex').slice(0, 12)
        const encodedName = encodeSegment(fileName)
        for (const face of faces) {
          const relPath = face.faceCount > 1
            ? `${rev}/${encodedName}/${face.faceIndex}`
            : `${rev}/${encodedName}`
          if (nextByPath.has(relPath)) {
            warnOnce(`two font files resolve to the same URL "${relPath}"; keeping the first`)
            continue
          }
          const contentType = face.container === 'ttc'
            ? (face.format === 'opentype' ? 'font/otf' : 'font/ttf')
            : descriptor.contentType
          const formatHint = face.container === 'ttc' ? face.format : descriptor.formatHint
          const entry = {
            relPath,
            urlPath: `${options.routePath}/${relPath}`,
            filePath,
            fileName,
            rev,
            container: face.container,
            dirOffset: face.dirOffset,
            faceIndex: face.faceIndex,
            faceCount: face.faceCount,
            family: face.family,
            weight: face.weight,
            italic: face.italic,
            contentType,
            formatHint,
          }
          next.push(entry)
          nextByPath.set(relPath, entry)
        }
      }
    }
    next.sort((left, right) => left.family.localeCompare(right.family)
      || left.weight - right.weight
      || Number(left.italic) - Number(right.italic)
      || left.relPath.localeCompare(right.relPath))
    entries = next
    byPath = nextByPath
    return entries
  }

  function lookup(relPath) {
    return byPath.get(relPath)
  }

  /** Read the bytes a browser should receive for one entry. */
  async function read(entry) {
    if (entry.container !== 'ttc') return readFile(entry.filePath)
    const cached = extracted.get(entry.relPath)
    if (cached !== undefined) return cached
    const buffer = await readFile(entry.filePath)
    const face = extractFace(buffer, entry.dirOffset)
    if (extracted.size >= EXTRACTED_CACHE_SIZE) {
      const oldest = extracted.keys().next().value
      if (oldest !== undefined) extracted.delete(oldest)
    }
    extracted.set(entry.relPath, face)
    return face
  }

  return { scan, lookup, read }
}

/** Read a file synchronously, returning `null` when it cannot be read. */
function readFileSyncSafe(filePath) {
  try {
    return readFileSync(filePath)
  } catch {
    return null
  }
}
