/**
 * @font-face CSS for the scanned entries.
 *
 * One rule per distinct family/weight/slant, in a deterministic order so the
 * injected text does not churn between renders. When a family offers the same
 * face in several files, the most compact container wins (`woff2` before
 * `woff`, and either before a face split out of a `.ttc` collection), because
 * a browser treats them as the same face. The URL is absolute: the shell is
 * served from the server root, so an absolute path also survives a document
 * URL that carries a route segment.
 */

/** Preference rank per `format()` hint; lower is served first. */
const FORMAT_RANK = { woff2: 0, woff: 1, truetype: 2, opentype: 2 }

/** Escape a family name for a double-quoted CSS string. */
function quoteFamily(family) {
  const escaped = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
  return `"${escaped}"`
}

/** Pick one entry per family/weight/slant, preferring the smallest container. */
function selectFaces(entries) {
  const winners = new Map()
  for (const entry of entries) {
    const key = `${entry.family}\u0000${entry.weight}\u0000${entry.italic}`
    const current = winners.get(key)
    if (current === undefined || better(preference(entry), preference(current))) winners.set(key, entry)
  }
  return [...winners.values()].sort((left, right) => left.family.localeCompare(right.family)
    || left.weight - right.weight
    || Number(left.italic) - Number(right.italic)
    || left.relPath.localeCompare(right.relPath))
}

/**
 * Rank competing files for the same family/weight/slant, lower is better.
 *
 * A collection carries several designs under one weight: `Extended` changes the
 * width, `Oblique` is a slanted roman, and `Italic` is the drawn italic. Prefer
 * the plain width and the drawn italic, then the most compact container.
 */
function preference(entry) {
  const subfamily = (entry.subfamily ?? '').toLowerCase()
  const widthPenalty = /extended|expanded|condensed|narrow|wide|semicondensed/u.test(subfamily) ? 1 : 0
  const slantPenalty = entry.italic ? (/italic/u.test(subfamily) ? 0 : /oblique/u.test(subfamily) ? 1 : 2) : 0
  return [FORMAT_RANK[entry.formatHint] ?? 3, widthPenalty, slantPenalty, entry.relPath]
}

/** Compare two preference tuples. */
function better(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] < right[index]) return true
    if (left[index] > right[index]) return false
  }
  return false
}

/**
 * Build the style element text for every entry.
 * @param entries - scanner entries.
 * @param options - `fontDisplay` value for the CSS rows.
 * @returns the CSS text, or an empty string when nothing was found.
 */
export function buildFontFaceCss(entries, options) {
  const faces = selectFaces(entries)
  if (faces.length === 0) return ''
  const rules = faces.map(entry => (
    `@font-face{font-family:${quoteFamily(entry.family)};`
    + `font-style:${entry.italic ? 'italic' : 'normal'};`
    + `font-weight:${entry.weight};`
    + `font-display:${options.fontDisplay};`
    + `src:url("${entry.urlPath}") format("${entry.formatHint}")}`
  ))
  return `/* dsh-ui-font-extension: ${rules.length} face(s) from local font directories */\n${rules.join('\n')}\n`
}
