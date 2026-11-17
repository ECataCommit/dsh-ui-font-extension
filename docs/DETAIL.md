# Local font files

## What it does

`dsh-ui-font-extension` reads the font files in one or more local directories and
serves them from the Harness web server, then injects the matching `@font-face`
rules into every page shell the server renders. Family names therefore resolve
against files the server owns instead of fonts installed on the client host, and
every browser — regardless of operating system or installed fonts — renders the
same typography.

The bundle ships no font bytes. Font storage stays on the machine that runs the
Harness.

## Usage

1. Create the default directory and put fonts in it:

   ```sh
   mkdir -p ~/.dsh/fonts
   cp SomeFont-*.woff2 ~/.dsh/fonts/
   ```

2. Reload the page. Each detected face becomes one `@font-face` rule whose family
   is the family recorded inside the font file.

3. Select that family in **Settings → Appearance → Fonts**, or keep an existing
   configuration that already names it.

Adding or replacing a font needs no restart: the directory is rescanned while the
page shell is rendered, and the URL carries a content revision so caches never
serve stale bytes.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `dirs` | `["~/.dsh/fonts"]` | Directories scanned for fonts. `~` expands; symlinks are followed. |
| `routePath` | `/dsh-fonts` | URL prefix serving the files. |
| `fontDisplay` | `swap` | CSS `font-display` for every rule. |
| `maxFileBytes` | `67108864` | Per-file ceiling; larger files are skipped with one warning. |

The same keys may live in `$DSH_HOME/font-extension.json`; the Loader row config
takes precedence.

## Format support

| Container | Handling |
| --- | --- |
| `.woff2`, `.woff` | Served as-is. |
| `.ttf`, `.otf` | Served as-is. |
| `.ttc`, `.otc` | One standalone sfnt is built per requested face, since browsers do not load collections. |

Family, subfamily, weight and slant come from the `name` and `OS/2` tables; a file
without a usable `name` table falls back to its file name.

## Limitations

- The page shell injection targets the Web Harness. The Electron desktop app
  loads its shell through a different path.
- Synthetic bold appears when a family has no bold face.
- Collection faces are served uncompressed. Convert to `.woff2` with
  `scripts/convert-to-woff2.py` when bandwidth matters, optionally subsetting
  Chinese to common characters.
- A family/weight/slant available in several files resolves to one of them,
  preferring `woff2`, then `woff`, then a collection face.
- The font route is admitted anonymously. Remove the bundle if serving font
  files without a page session is unacceptable in your deployment.
