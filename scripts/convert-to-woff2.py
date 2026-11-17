#!/usr/bin/env python3
"""Convert fonts to .woff2 for dsh-ui-font-extension.

The plugin serves `.woff2` and serves `.ttc` faces as uncompressed sfnt. Use this
script when you want smaller downloads, or a Chinese subset instead of the whole
glyph set.

Examples
--------
Convert every face of a collection (the file name records the face):

    python3 scripts/convert-to-woff2.py /System/Library/Fonts/Supplemental/Songti.ttc -o ~/.dsh/fonts

Keep only common Chinese characters (GB2312) plus Latin and punctuation:

    python3 scripts/convert-to-woff2.py Songti.ttc --subset gb2312 -o ~/.dsh/fonts

Convert one face of a collection by PostScript name:

    python3 scripts/convert-to-woff2.py Songti.ttc --face STSongti-SC-Regular -o ~/.dsh/fonts

Convert a plain font:

    python3 scripts/convert-to-woff2.py Iosevka-Regular.ttf -o ~/.dsh/fonts

Requires fontTools with Brotli support (`pip install fonttools brotli`).
"""

from __future__ import annotations

import argparse
import os
import re
import sys

try:
    from fontTools.ttLib import TTCollection, TTFont
    from fontTools.subset import Options, Subsetter
except ImportError:  # pragma: no cover - dependency guidance
    sys.exit("fontTools is required: pip install fonttools brotli")

LATIN_AND_PUNCTUATION = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + list(range(0x2000, 0x2070))
    + list(range(0x3000, 0x3040))
    + list(range(0xFF00, 0xFFF0))
)

SUBSETS = {
    "none": None,
    "latin": LATIN_AND_PUNCTUATION,
    "gb2312": None,
    "gbk": None,
    "cjk": None,
}


def subset_codepoints(kind: str, cmap) -> list[int]:
    """Return the codepoints kept for one subset name."""
    if kind == "latin":
        return [code for code in LATIN_AND_PUNCTUATION if code in cmap]
    if kind == "cjk":
        kept = set(LATIN_AND_PUNCTUATION)
        kept.update(code for code in range(0x4E00, 0xA000) if code in cmap)
        kept.update(code for code in range(0x3400, 0x4DC0) if code in cmap)
        return sorted(kept)
    if kind in ("gb2312", "gbk"):
        kept = set(LATIN_AND_PUNCTUATION)
        lead_start, lead_end = (0xA1, 0xFF) if kind == "gb2312" else (0x81, 0xFF)
        encoding = "gb2312" if kind == "gb2312" else "gbk"
        for lead in range(lead_start, lead_end):
            for trail in range(0xA1, 0xFF):
                try:
                    kept.add(ord(bytes([lead, trail]).decode(encoding)))
                except (UnicodeDecodeError, ValueError):
                    continue
        return sorted(code for code in kept if code in cmap)
    return []


def safe_name(text: str) -> str:
    """Turn a name into a file-name-safe fragment."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")
    return cleaned or "font"


def face_label(font: TTFont, index: int) -> str:
    """Name one face for the output file."""
    name = font["name"]
    postscript = name.getDebugName(6) or name.getDebugName(4) or name.getDebugName(1) or f"face{index}"
    return safe_name(postscript)


def write_face(font: TTFont, label: str, output_dir: str, subset: str) -> str:
    """Subset and save one face as woff2; returns the written path."""
    if subset != "none":
        codepoints = subset_codepoints(subset, font.getBestCmap())
        options = Options()
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.notdef_outline = True
        options.recalc_bounds = True
        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes=codepoints)
        subsetter.subset(font)
    font.flavor = "woff2"
    os.makedirs(output_dir, exist_ok=True)
    target = os.path.join(output_dir, f"{label}.woff2")
    font.save(target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert fonts to woff2 for dsh-ui-font-extension.")
    parser.add_argument("source", help="path to a .ttf/.otf/.ttc/.otc file")
    parser.add_argument("-o", "--out", default=".", help="output directory (default: current)")
    parser.add_argument("--subset", choices=sorted(SUBSETS), default="none",
                        help="glyph subset to keep (default: none, keep everything)")
    parser.add_argument("--face", action="append", default=[], metavar="POSTSCRIPT",
                        help="only convert the named face(s) of a collection; repeatable")
    arguments = parser.parse_args()

    extension = os.path.splitext(arguments.source)[1].lower()
    written: list[str] = []
    if extension in (".ttc", ".otc"):
        collection = TTCollection(arguments.source)
        wanted = {value.lower() for value in arguments.face}
        for index, font in enumerate(collection.fonts):
            label = face_label(font, index)
            if wanted and label.lower() not in wanted:
                continue
            written.append(write_face(font, label, arguments.out, arguments.subset))
    else:
        font = TTFont(arguments.source)
        written.append(write_face(font, face_label(font, 0), arguments.out, arguments.subset))

    for path in written:
        print(f"{os.path.getsize(path) // 1024:>8} KB  {path}")
    if not written:
        print("no face selected", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
