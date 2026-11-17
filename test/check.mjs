/**
 * Local smoke test: scan a directory holding a collection, a plain sfnt and a
 * woff2, build the CSS, and answer a font request through the fake Harness
 * context the plugin would receive.
 *
 * Run with: node test/check.mjs <font-directory>
 */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFontFaceCss } from '../lib/css.js'
import { createScanner } from '../lib/scan.js'
import { apply } from '../index.js'

const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: node test/check.mjs <font-directory>')

const messages = []
const scanner = createScanner({
  dirs: [dir],
  routePath: '/dsh-fonts',
  maxFileBytes: 64 * 1024 * 1024,
  log: (level, message) => messages.push(`${level}: ${message}`),
})
const entries = scanner.scan()
console.log(`entries: ${entries.length}`)
for (const entry of entries.slice(0, 40)) {
  console.log(`  ${entry.relPath.padEnd(46)} ${entry.family} | ${entry.weight}${entry.italic ? ' italic' : ''} | ${entry.formatHint}`)
}
console.log('--- css ---')
console.log(buildFontFaceCss(entries, { fontDisplay: 'swap' }))
console.log('--- log ---')
for (const message of messages) console.log(message)

// A collection face must come back as a standalone sfnt.
const collection = entries.find(entry => entry.container === 'ttc')
if (collection !== undefined) {
  const bytes = await scanner.read(collection)
  const out = join(mkdtempSync(join(tmpdir(), 'dsh-font-')), 'face.ttf')
  writeFileSync(out, bytes)
  console.log(`extracted ${collection.family} -> ${out} (${bytes.length} bytes)`)
}

// Drive one request through the real plugin entry with a stub context.
const routes = []
const listeners = []
const stub = {
  logger: { warn: message => messages.push(`warn: ${message}`), info: () => {}, debug: () => {} },
  effect: factory => factory(),
  on: (event, handler) => listeners.push({ event, handler }),
  webServer: { register: route => { routes.push(route); return () => {} } },
}
apply(stub, { dirs: [dir] })
const table = []
for (const listener of listeners) listener.handler(table)
console.log(`index injections: ${table.length} (${table.map(row => row.kind).join(', ')})`)
const first = entries[0]
const response = await routes[0].resource(new Request(`http://localhost/dsh-fonts/${first.relPath}`))
console.log(`GET ${first.relPath} -> ${response.status} ${response.headers.get('content-type')} ${response.headers.get('content-length')} bytes`)
const missing = await routes[0].resource(new Request('http://localhost/dsh-fonts/nope/nope.woff2'))
console.log(`GET missing -> ${missing.status}`)
const head = await routes[0].resource(new Request(`http://localhost/dsh-fonts/${first.relPath}`, { method: 'HEAD' }))
console.log(`HEAD -> ${head.status} body=${head.body === null ? 'null' : 'present'}`)
