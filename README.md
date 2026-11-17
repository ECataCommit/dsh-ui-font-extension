# Local font files

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
turns the fonts you keep in a local folder into web fonts for every browser that
opens the Harness.

Typography follows the font *files*, not the operating system of the machine you
browse from. Install the fonts once where the Harness runs, and every client —
another laptop, a tablet, a phone on the same Tailscale network — renders the
same glyphs, weights and metrics.

## Why

A browser resolves a CSS `font-family` name against the fonts installed on the
*client* host. Remote browsers rarely have the same fonts, so a font list such as
`"Georgia", "Songti SC"` silently falls back to the system default elsewhere.

This plugin serves the font bytes from the Harness web server and injects
`@font-face` rules into the page shell, so the family name resolves to a file the
server owns.

## Install

The bundle is a plain package with no build step and no dependencies.

- In the Harness UI, open **Plugins → Add plugin**, paste the absolute path of
  this directory, and enable the bundle.
- A Host-side caller can install the same directory through the plugin manager
  (`install_bundle` with the absolute package directory as the target).
- Replacing an installed copy needs a restart to load the new JavaScript.

## Use

1. Put font files in the directory the plugin reads, by default `~/.dsh/fonts`:

   ```sh
   mkdir -p ~/.dsh/fonts
   cp ~/Downloads/YourFont-*.woff2 ~/.dsh/fonts/
   ```

2. Reload the Harness page. The plugin injects one `@font-face` per detected
   face, named after the font's own family.

3. Pick the family in **Settings → Appearance → Fonts**, or keep any existing
   configuration that already names it. The family name is the one inside the
   font, so `"Songti SC"` and `"Iosevka"` work unchanged.

Supported formats: `.woff2`, `.woff`, `.ttf`, `.otf`, plus the collections
`.ttc` / `.otc`. Collection faces are split into standalone sfnt files in
memory, because browsers do not load collection files directly; only the face a
page actually needs is built, and the last few stay cached.

## Configuration

Optional, all fields are optional:

```yaml
- id: ui-font-extension
  name: dsh-ui-font-extension
  config:
    dirs:
      - ~/.dsh/fonts
      - /Volumes/Sync/Fonts
    routePath: /dsh-fonts      # URL prefix serving the files
    fontDisplay: swap          # auto | block | swap | fallback | optional
    maxFileBytes: 67108864     # per-file ceiling
```

The same values can live in a JSON file at `$DSH_HOME/font-extension.json`
(default `~/.dsh/font-extension.json`); the Loader row config wins over the file.
Directories are rescanned on every page render, so adding a file needs no
restart. A directory may contain symlinks — a link to a system font such as
`/System/Library/Fonts/Supplemental/Songti.ttc` works.

## How it serves

- URL shape: `/dsh-fonts/<content-revision>/<file-name>[/<face-index>]`.
  The revision changes when the file's size or modification time changes, so the
  immutable cache never serves stale bytes.
- Response: `200` with the font's media type and
  `cache-control: public, max-age=31536000, immutable`; `304` honours
  `if-none-match`; `405` for anything but `GET`/`HEAD`.
- Requests never name a filesystem path: the route looks up a key built from a
  directory listing, so `..` cannot escape a configured directory.
- The route is admitted anonymously because fonts are ordinary assets and a font
  request carries no page state. Remove the plugin if that is not acceptable in
  your deployment.

## Trade-offs

- **Body weight and slant come from the font.** A family with only one file
  renders synthetic bold for `700`. Add a real bold face to get crisp weight.
- **`.ttc` faces are served as uncompressed sfnt.** That is larger on the wire
  than a `.woff2`; convert collections ahead of time with
  `scripts/convert-to-woff2.py` when size matters.
- **No CJK subsetting happens automatically.** A full Songti SC renders at about
  9.5 MB as `.woff2`; the helper script can subset to common Chinese first.
- Only the **web** Harness serves pages this way. The Electron desktop app loads
  its shell differently, so this plugin targets the Web UI.

## License

MIT for the plugin. It ships no fonts: the license of each font file you place
in the directory governs that file.
