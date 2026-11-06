#!/usr/bin/env python3
"""Build EightyTwenty buyer-deliverable files for all 50 digital products.

Reads source product folders from ~/workspace/digital-marketplace/products/<SKU>/
and writes, for every SKU:
  - downloads/<SKU>.pdf   (course PDF: cover, onboarding, content, workbook)
  - downloads/<SKU>.zip   (PDF + source md files + original cover + templates)
  - public/covers/<SKU>.jpg (web cover thumbnail, max 800px wide)
  - downloads/manifest.json

Re-runnable: regenerates everything from the product folders.
Uses only fpdf2, Pillow, pypdf and the standard library.
Run with /tmp/pdfvenv/bin/python tools/build-products.py
"""

import hashlib
import json
import os
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

from fpdf import FPDF
from PIL import Image
from pypdf import PdfReader

APP_ROOT = Path(__file__).resolve().parent.parent
PRODUCTS_ROOT = Path.home() / "workspace" / "digital-marketplace" / "products"
DOWNLOADS = APP_ROOT / "downloads"
COVERS_DIR = APP_ROOT / "public" / "covers"

# --- Colours / typography ---------------------------------------------------
BLACK = (17, 17, 17)        # #111111
GOLD = (201, 162, 39)       # #C9A227
WHITE = (255, 255, 255)
GREY = (120, 120, 120)
BODY = 11.0                 # pt
LINE_H = 6.0                # mm, ~1.4 line height for 11pt
MARGIN = 20.0               # mm

# Characters not encodable in the core Helvetica (latin-1) fonts, and their
# plain-text replacements. A generic fallback below catches anything else,
# so nothing is ever dropped silently or crashes the build.
SANITIZE = {
    "\u2014": "--",   # em dash
    "\u2013": "-",    # en dash
    "\u2018": "'",    # left single quote
    "\u2019": "'",    # right single quote
    "\u201c": '"',    # left double quote
    "\u201d": '"',    # right double quote
    "\u2026": "...",  # ellipsis
    "\u2022": "-",    # bullet
    "\u2610": "[ ]",  # ballot box
    "\u2212": "-",    # minus sign
    "\u2192": "->",   # right arrow
    "\u2248": "~",    # approx
    "\u2265": ">=",
    "\u2264": "<=",
    "\u2122": "(TM)", # trademark
    "\u2713": "[x]",  # check mark
    "\u2717": "[ ]",  # ballot x
}


def _break_long_tokens(text: str, chunk: int = 45) -> str:
    """Split unbroken runs longer than `chunk` chars so fpdf can wrap them.
    Only affects tokens no line could ever fit (e.g. 70-char fill-in lines
    of underscores in workbooks); the characters themselves are preserved."""
    def split(m):
        tok = m.group(0)
        return " ".join(tok[i:i + chunk] for i in range(0, len(tok), chunk))
    return re.sub(r"\S{" + str(chunk + 1) + r",}", split, text)


def clean(text: str) -> str:
    for bad, good in SANITIZE.items():
        text = text.replace(bad, good)
    out = []
    for ch in text:
        if ord(ch) <= 255:
            out.append(ch)
        else:
            dec = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(dec if dec else "?")
    return _break_long_tokens("".join(out))


# --- Inline markdown --------------------------------------------------------
# parse_inline returns a list of (text, style) where style is one of
# "", "B", "I", "BI", "code". Handles **bold**, *italic*, `code`,
# including nested bold+italic.

def parse_inline(text: str):
    text = clean(text)
    segments = []
    buf = []
    bold = italic = code = False

    def flush():
        if buf:
            style = "code" if code else ("B" if bold else "") + ("I" if italic else "")
            if style == "BI":
                style = "BI"
            segments.append(("".join(buf), style))
            buf.clear()

    i, n = 0, len(text)
    while i < n:
        if not code and text.startswith("**", i):
            flush()
            bold = not bold
            i += 2
        elif not code and text[i] == "*":
            flush()
            italic = not italic
            i += 1
        elif text[i] == "`":
            flush()
            code = not code
            i += 1
        else:
            buf.append(text[i])
            i += 1
    flush()
    return segments


class ProductPDF(FPDF):
    def __init__(self, name: str):
        super().__init__("P", "mm", "Letter")
        self.product_name = name
        self.show_footer = False
        self.set_auto_page_break(auto=True, margin=MARGIN)
        self.set_margins(MARGIN, MARGIN, MARGIN)

    def footer(self):
        if not self.show_footer:
            return
        self.set_y(-14)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*GREY)
        self.cell(0, 5, clean(f"EightyTwenty -- {self.product_name}"), align="L")
        self.set_y(-14)
        self.cell(0, 5, f"Page {self.page_no()}", align="R")

    # -- low-level helpers ---------------------------------------------------
    def _write_segments(self, segments, size=BODY, line_h=LINE_H):
        for text, style in segments:
            if style == "code":
                self.set_font("Courier", "", max(8.0, size - 1))
            else:
                self.set_font("Helvetica", style, size)
            self.set_text_color(0, 0, 0)
            self.write(line_h, text)

    def paragraph(self, text, size=BODY, space_after=2.5):
        if not text.strip():
            return
        self._write_segments(parse_inline(text), size=size)
        self.ln(LINE_H)
        if space_after:
            self.ln(space_after)

    def heading(self, text, level):
        sizes = {1: 20, 2: 15, 3: 12.5, 4: 11.5}
        size = sizes.get(level, 11.5)
        # Keep a heading with at least a couple of lines of body text.
        if self.get_y() > self.h - MARGIN - 28:
            self.add_page()
        self.ln(4 if level > 1 else 6)
        self.set_font("Helvetica", "B", size)
        self.set_text_color(*BLACK)
        self.multi_cell(0, size * 0.45, clean(text), new_x="LMARGIN", new_y="NEXT")
        if level <= 2:
            y = self.get_y() + 0.5
            self.set_draw_color(*GOLD)
            self.set_line_width(0.5)
            self.line(MARGIN, y, self.w - MARGIN, y)
            self.ln(2.5)
        else:
            self.ln(1.5)

    def bullet(self, text, indent_level=0, ordered_num=None):
        x0 = MARGIN + indent_level * 8
        self.set_x(x0)
        marker = f"{ordered_num}. " if ordered_num is not None else "\u00b7  "
        self.set_font("Helvetica", "", BODY)
        self.set_text_color(0, 0, 0)
        self.write(LINE_H, marker)
        self._write_segments(parse_inline(text))
        self.ln(LINE_H)
        self.ln(1.2)

    def hrule(self):
        self.ln(2)
        y = self.get_y()
        self.set_draw_color(*GOLD)
        self.set_line_width(0.4)
        self.line(MARGIN, y, self.w - MARGIN, y)
        self.ln(3)

    # -- block-level markdown renderer ---------------------------------------
    def render_markdown(self, text: str):
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].rstrip()
            stripped = line.strip()

            if not stripped:
                i += 1
                continue

            # Headings
            m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
            if m:
                self.heading(m.group(2).strip(), len(m.group(1)))
                i += 1
                continue

            # Horizontal rule
            if re.match(r"^(\*\*\*|---|___)\s*$", stripped):
                self.hrule()
                i += 1
                continue

            # Tables: consecutive lines starting with |
            if stripped.startswith("|"):
                rows = []
                while i < len(lines) and lines[i].strip().startswith("|"):
                    rows.append(lines[i].strip())
                    i += 1
                self.render_table(rows)
                continue

            # Blockquotes: consecutive lines starting with >
            if stripped.startswith(">"):
                quote_lines = []
                while i < len(lines) and lines[i].strip().startswith(">"):
                    quote_lines.append(lines[i].strip()[1:].strip())
                    i += 1
                self.set_x(MARGIN + 8)
                self.set_font("Helvetica", "I", BODY)
                self.set_text_color(60, 60, 60)
                self.multi_cell(self.w - 2 * MARGIN - 8, LINE_H,
                                clean(" ".join(quote_lines)), new_x="LMARGIN", new_y="NEXT")
                self.set_text_color(0, 0, 0)
                self.ln(2.5)
                continue

            # Unordered list item
            m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
            if m:
                level = len(m.group(1)) // 2
                self.bullet(m.group(2), indent_level=level)
                i += 1
                continue

            # Ordered list item
            m = re.match(r"^(\s*)(\d+)\.\s+(.*)$", line)
            if m:
                level = len(m.group(1)) // 2
                self.bullet(m.group(3), indent_level=level,
                            ordered_num=int(m.group(2)))
                i += 1
                continue

            # Plain paragraph (fall back: any other construct is a paragraph,
            # so nothing is ever dropped).
            self.paragraph(stripped)
            i += 1

    def render_table(self, rows):
        parsed = []
        for row in rows:
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            # Skip the markdown separator row (all dashes/colons).
            if all(re.match(r"^:?-+:?$", c) for c in cells):
                continue
            parsed.append(cells)
        if not parsed:
            return
        for idx, cells in enumerate(parsed):
            text = " | ".join(cells)
            if idx == 0:
                self.set_font("Helvetica", "B", BODY)
                self.set_text_color(0, 0, 0)
                self.multi_cell(0, LINE_H, clean(text), new_x="LMARGIN", new_y="NEXT")
            else:
                self.set_font("Helvetica", "", BODY)
                self.set_text_color(0, 0, 0)
                self.multi_cell(0, LINE_H, clean(text), new_x="LMARGIN", new_y="NEXT")
        self.ln(2.5)

    # -- special pages ---------------------------------------------------------
    def cover_page(self, title, subtitle, category, cover_jpg: Path):
        self.add_page()
        self.show_footer = False
        self.rect(0, 0, self.w, self.h, style="F")
        self.set_fill_color(*BLACK)
        self.rect(0, 0, self.w, self.h, style="F")
        self.set_y(26)
        self.set_text_color(*GOLD)
        self.set_font("Helvetica", "B", 26)
        self.multi_cell(0, 11, clean(title), align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(4)
        self.set_text_color(*WHITE)
        self.set_font("Helvetica", "", 13)
        self.multi_cell(0, 6.5, clean(subtitle), align="C", new_x="LMARGIN", new_y="NEXT")
        # Cover image: fit inside a 100 x 150 mm box, centred.
        with Image.open(cover_jpg) as im:
            iw, ih = im.size
        box_w, box_h = 100.0, 150.0
        scale = min(box_w / iw, box_h / ih)
        w_mm = iw * scale
        h_mm = ih * scale
        y = self.get_y() + 6
        if y + h_mm > 248:
            h_mm = 248 - y
            w_mm = h_mm * iw / ih
        self.image(str(cover_jpg), x=(self.w - w_mm) / 2, y=y, w=w_mm, h=h_mm)
        # Bottom brand line.
        self.set_y(260)
        self.set_text_color(*GOLD)
        self.set_font("Helvetica", "B", 12)
        self.cell(0, 6, f"EightyTwenty -- {category}", align="C")

    def divider_page(self, title, name):
        self.add_page()
        self.show_footer = False
        self.set_fill_color(*BLACK)
        self.rect(0, 0, self.w, self.h, style="F")
        self.set_y(120)
        self.set_text_color(*GOLD)
        self.set_font("Helvetica", "B", 32)
        self.cell(0, 14, clean(title), align="C")
        self.ln(16)
        self.set_text_color(*WHITE)
        self.set_font("Helvetica", "", 14)
        self.cell(0, 7, clean(name), align="C")


def subtitle_from_cover(cover_md: Path, headline: str) -> str:
    text = cover_md.read_text(encoding="utf-8")
    m = re.search(r"-\s*\*\*Subtitle:\*\*\s*(.+)", text)
    if m:
        return m.group(1).strip()
    return headline


def find_cover_image(product_dir: Path) -> Path:
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = product_dir / f"cover{ext}"
        if p.exists():
            return p
    raise FileNotFoundError(f"No cover image in {product_dir}")


def make_web_cover(src: Path, dest: Path) -> Path:
    with Image.open(src) as im:
        im = im.convert("RGB")
        if im.width > 800:
            im = im.resize((800, int(im.height * 800 / im.width)),
                           Image.LANCZOS)
        im.save(dest, "JPEG", quality=82)
    return dest


def build_pdf(sku: str, listing: dict, product_dir: Path, web_cover: Path,
              pdf_path: Path) -> int:
    name = listing["name"]
    category = listing["category"]
    subtitle = subtitle_from_cover(product_dir / "cover.md",
                                   listing.get("headline", ""))
    pdf = ProductPDF(name)
    pdf.set_title(name)
    pdf.set_author("EightyTwenty")

    # 1. Cover
    pdf.cover_page(name, subtitle, category, web_cover)

    # 2. How to use this product (from onboarding.md, skipping its own H1)
    pdf.add_page()
    pdf.show_footer = True
    pdf.heading("How to Use This Product", 1)
    onboarding = (product_dir / "onboarding.md").read_text(encoding="utf-8")
    lines = onboarding.splitlines()
    # Drop the first H1 (the "Customer Onboarding Guide -- ..." title line).
    for idx, ln in enumerate(lines):
        if ln.strip().startswith("# "):
            lines = lines[idx + 1:]
            break
    pdf.render_markdown("\n".join(lines))

    # 3. Full course content
    pdf.render_markdown((product_dir / "content.md").read_text(encoding="utf-8"))

    # 4. Workbook divider + workbook
    pdf.divider_page("Workbook", name)
    pdf.add_page()
    pdf.show_footer = True
    pdf.render_markdown((product_dir / "workbook.md").read_text(encoding="utf-8"))

    pdf.output(str(pdf_path))
    return pdf.pages_count


def build_zip(sku: str, product_dir: Path, pdf_path: Path, zip_path: Path):
    cover_img = find_cover_image(product_dir)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(pdf_path, f"{sku}/{sku}.pdf")
        for fname in ("content.md", "workbook.md", "onboarding.md", "README.md"):
            z.write(product_dir / fname, f"{sku}/{fname}")
        z.write(cover_img, f"{sku}/{cover_img.name}")
        templates = product_dir / "templates"
        if templates.is_dir():
            for f in sorted(templates.iterdir()):
                if f.is_file():
                    z.write(f, f"{sku}/templates/{f.name}")
    with zipfile.ZipFile(zip_path) as z:
        bad = z.testzip()
    if bad is not None:
        raise RuntimeError(f"ZIP corrupt entry {bad} in {zip_path}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    skus = sorted(p.name for p in PRODUCTS_ROOT.iterdir() if p.is_dir())
    print(f"Building {len(skus)} products...")
    manifest = {"products": [], "totals": {}}
    total_pdf = total_zip = total_cover = 0

    for sku in skus:
        pdir = PRODUCTS_ROOT / sku
        listing = json.loads((pdir / "listing.json").read_text(encoding="utf-8"))
        cover_img = find_cover_image(pdir)
        web_cover = COVERS_DIR / f"{sku}.jpg"
        make_web_cover(cover_img, web_cover)
        pdf_path = DOWNLOADS / f"{sku}.pdf"
        pages = build_pdf(sku, listing, pdir, web_cover, pdf_path)
        zip_path = DOWNLOADS / f"{sku}.zip"
        build_zip(sku, pdir, pdf_path, zip_path)
        entry = {
            "sku": sku,
            "name": listing["name"],
            "pdf_bytes": pdf_path.stat().st_size,
            "pdf_pages": pages,
            "zip_bytes": zip_path.stat().st_size,
            "cover_jpg_bytes": web_cover.stat().st_size,
            "pdf_sha256": sha256(pdf_path),
            "zip_sha256": sha256(zip_path),
        }
        manifest["products"].append(entry)
        total_pdf += entry["pdf_bytes"]
        total_zip += entry["zip_bytes"]
        total_cover += entry["cover_jpg_bytes"]
        print(f"  {sku}: {pages} pages, "
              f"pdf {entry['pdf_bytes']/1024:.0f} KB, "
              f"zip {entry['zip_bytes']/1024:.0f} KB")

    manifest["totals"] = {
        "products": len(skus),
        "pdf_bytes": total_pdf,
        "zip_bytes": total_zip,
        "cover_jpg_bytes": total_cover,
        "total_bytes": total_pdf + total_zip + total_cover,
    }
    (DOWNLOADS / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Done. {len(skus)} products. "
          f"Total {manifest['totals']['total_bytes']/1024/1024:.1f} MB "
          f"(pdf {total_pdf/1024/1024:.1f} MB, zip {total_zip/1024/1024:.1f} MB, "
          f"covers {total_cover/1024:.0f} KB).")
    print("Manifest:", DOWNLOADS / "manifest.json")


if __name__ == "__main__":
    main()
