/**
 * dsh-ui-font-extension — local font files as web fonts for every browser.
 *
 * The plugin owns no font bytes. It reads the directories named in its config
 * (default `~/.dsh/fonts`), serves whatever fonts it finds from the Harness
 * web server under one URL prefix, and injects the matching `@font-face`
 * rules into every page shell the server renders. Any browser on any host
 * therefore renders the same typography, and adding a font means dropping a
 * file into the directory and reloading the page.
 *
 * Supported formats: `.woff2`, `.woff`, `.ttf`, `.otf`, and the collections
 * `.ttc`/`.otc` — collections are split per face in memory, because browsers
 * do not load collection files directly.
 *
 * @module dsh-ui-font-extension
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildFontFaceCss } from './lib/css.js'
import { createScanner } from './lib/scan.js'

/** Loader row name. */
export const name = 'dsh-ui-font-extension'

/** The web server is the only Host service this plugin needs. */
export const inject = ['webServer']

/** Directory read when the config names none. */
const DEFAULT_DIRS = ['~/.dsh/fonts']
/** URL prefix serving the fonts. */
const DEFAULT_ROUTE_PATH = '/dsh-fonts'
/** CSS `font-display` default; `swap` keeps text visible while a font arrives. */
const DEFAULT_FONT_DISPLAY = 'swap'
/** Per-file ceiling, large enough for any whole-family font. */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
/** Values CSS accepts for `font-display`. */
const FONT_DISPLAY_VALUES = new Set(['auto', 'block', 'swap', 'fallback', 'optional'])
/** Optional JSON file, read at activation, that can name extra directories. */
const CONFIG_FILE_NAME = 'font-extension.json'

/**
 * Register the font route and the page-shell style injection.
 * @param ctx - owning Cordis context.
 * @param config - optional `dirs`, `routePath`, `fontDisplay`, `maxFileBytes`.
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      // Logging must never break page rendering.
    }
  }
  const scanner = createScanner({
    dirs: options.dirs,
    routePath: options.routePath,
    maxFileBytes: options.maxFileBytes,
    log,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: options.routePath,
    // The files are ordinary assets, and a font request carries no page state;
    // admitting it anonymously keeps subresource loads independent of cookies.
    auth: 'anonymous',
    resource: request => respond(request),
  }), 'dsh-ui-font-extension: font route')

  ctx.on('webserver/index-inject', (table) => {
    let css
    try {
      css = buildFontFaceCss(scanner.scan(), options)
    } catch (error) {
      log('warn', `[dsh-ui-font-extension] scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (css !== '') table.push({ kind: 'style', text: css })
  })

  /**
   * Answer one font request. The path is an opaque key built from a directory
   * listing, never a filesystem path taken from the request.
   * @param request - Fetch request for the font route.
   * @returns the font bytes, 304, 404, or 405.
   */
  async function respond(request) {
    const method = request.method
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    const pathname = new URL(request.url).pathname
    let relPath = pathname.slice(options.routePath.length)
    if (relPath.startsWith('/')) relPath = relPath.slice(1)
    let entry
    try {
      entry = scanner.lookup(decodeURIComponent(relPath))
    } catch {
      entry = undefined
    }
    if (entry === undefined) {
      // A font may have been added or replaced since the last page render.
      scanner.scan()
      try {
        entry = scanner.lookup(decodeURIComponent(relPath))
      } catch {
        entry = undefined
      }
    }
    if (entry === undefined) {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
    }
    const etag = `"${entry.rev}"`
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } })
    }
    let bytes
    try {
      bytes = await scanner.read(entry)
    } catch (error) {
      log('warn', `[dsh-ui-font-extension] cannot read ${entry.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      return new Response(null, { status: 500, headers: { 'cache-control': 'no-store' } })
    }
    const headers = {
      'content-type': entry.contentType,
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag,
    }
    return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers })
  }
}

/** Merge defaults, the optional config file, and the Loader row config. */
function normalizeOptions(config) {
  const fileConfig = readConfigFile()
  const rowConfig = config !== null && typeof config === 'object' ? config : {}
  const merged = { ...fileConfig, ...rowConfig }

  const configuredDirs = Array.isArray(merged.dirs) ? merged.dirs : undefined
  const dirs = (configuredDirs ?? DEFAULT_DIRS)
    .filter(directory => typeof directory === 'string' && directory.trim() !== '')

  const routePath = normalizeRoutePath(merged.routePath)
  const fontDisplay = typeof merged.fontDisplay === 'string' && FONT_DISPLAY_VALUES.has(merged.fontDisplay)
    ? merged.fontDisplay
    : DEFAULT_FONT_DISPLAY
  const maxFileBytes = Number.isFinite(merged.maxFileBytes) && merged.maxFileBytes > 0
    ? merged.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES

  return { dirs, routePath, fontDisplay, maxFileBytes }
}

/** Normalize the URL prefix to a leading slash and no trailing slash. */
function normalizeRoutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_ROUTE_PATH
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Read the optional configuration file beside the Harness home directory. */
function readConfigFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    const parsed = JSON.parse(readFileSync(join(home, CONFIG_FILE_NAME), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
