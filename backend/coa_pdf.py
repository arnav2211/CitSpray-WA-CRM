"""COA / spec-sheet PDF renderer for the Product Documents library.

A COA is stored as plain data and drawn on the company letterhead on demand, so
"auto" documents always carry this month's dates while "locked" ones keep theirs.

Data shape (every part optional except at least one of info/sections):
{
  "title": "CERTIFICATE OF ANALYSIS",
  "info": [{"label": "COMMON NAME", "value": "Lemongrass Oil"}, ...],   # any rows, any order
  "show_mfg": true, "mfg_label": "MFG.DATE",
  "show_exp": true, "exp_label": "EXP.DATE",
  "date_mode": "auto" | "locked",
  "mfg_month": "2026-08",            # locked mode (YYYY-MM)
  "exp_month": "2028-08",            # locked mode, optional (else mfg + shelf life)
  "shelf_life_months": 24,
  "sections": [{"title": "PHYSICO-CHEMICAL PROPERTIES",
                "columns": ["Parameters", "Specification", "Results"],
                "rows": [["COLOUR AND APPEARANCE", "PALE YELLOW ...", "Complies"], ...]}],
  "note": "NOTE : Keep in tightly closed container ...",
  "letterhead": true                 # false = plain page, no company header/footer
}
"""
from __future__ import annotations

import io
import os
from datetime import datetime
from pathlib import Path
from typing import Optional
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ASSETS = Path(__file__).parent / "assets" / "letterhead"
PAGE_W, PAGE_H = letter  # the sample COA is US Letter (612 x 792 pt)

_FONT = None


def _font() -> tuple:
    """(regular, bold) font names. Calibri-metric Carlito if present, else Liberation/DejaVu, else Helvetica."""
    global _FONT
    if _FONT:
        return _FONT
    candidates = [
        ("/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf", "/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf"),
        ("C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/calibrib.ttf"),
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    for reg, bold in candidates:
        if os.path.exists(reg) and os.path.exists(bold):
            try:
                pdfmetrics.registerFont(TTFont("CoaReg", reg))
                pdfmetrics.registerFont(TTFont("CoaBold", bold))
                _FONT = ("CoaReg", "CoaBold")
                return _FONT
            except Exception:
                continue
    _FONT = ("Helvetica", "Helvetica-Bold")
    return _FONT


def _month_add(y: int, m: int, add: int) -> tuple:
    t = y * 12 + (m - 1) + add
    return t // 12, t % 12 + 1


def _fmt_month(y: int, m: int) -> str:
    return datetime(y, m, 1).strftime("%b %Y")


def coa_dates(data: dict, today: Optional[datetime] = None) -> tuple:
    """(mfg_text, exp_text) for the document right now."""
    today = today or datetime.now()
    shelf = int(data.get("shelf_life_months") or 0)
    if (data.get("date_mode") or "auto") == "locked" and data.get("mfg_month"):
        y, m = (int(x) for x in str(data["mfg_month"])[:7].split("-"))
    else:
        y, m = today.year, today.month
    mfg = _fmt_month(y, m)
    if (data.get("date_mode") == "locked") and data.get("exp_month"):
        ey, em = (int(x) for x in str(data["exp_month"])[:7].split("-"))
        exp = _fmt_month(ey, em)
    elif shelf > 0:
        exp = _fmt_month(*_month_add(y, m, shelf))
    else:
        exp = ""
    return mfg, exp


def _letterhead(company: str) -> tuple:
    """(header_png, footer_png) for a company, or (None, None) to draw a plain text header."""
    d = ASSETS / (company or "citspray")
    h, f = d / "header.png", d / "footer.png"
    return (str(h) if h.exists() else None, str(f) if f.exists() else None)


def render_coa_pdf(data: dict, company: str = "citspray", company_name: str = "",
                   today: Optional[datetime] = None) -> bytes:
    reg, bold = _font()
    plain = data.get("letterhead") is False      # rarely used: no company letterhead at all
    header_png, footer_png = (None, None) if plain else _letterhead(company)
    head_h = PAGE_W * 380 / 1700 if header_png else (40 if plain else 60)
    foot_h = PAGE_W * 167 / 1700 if footer_png else 20

    def on_page(c, _doc):
        if plain:
            return
        c.saveState()
        if header_png:
            c.drawImage(header_png, 0, PAGE_H - head_h, width=PAGE_W, height=head_h, mask="auto")
        else:
            c.setFont(bold, 20)
            c.drawCentredString(PAGE_W / 2, PAGE_H - 40, company_name or "")
            c.setLineWidth(1)
            c.line(26, PAGE_H - head_h + 4, PAGE_W - 26, PAGE_H - head_h + 4)
        if footer_png:
            c.drawImage(footer_png, 0, 8, width=PAGE_W, height=foot_h, mask="auto")
        c.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=62, rightMargin=62,
                            topMargin=head_h + 14, bottomMargin=foot_h + 24,
                            title=(data.get("title") or "Certificate of Analysis"), author=company_name or "")
    s_title = ParagraphStyle("t", fontName=bold, fontSize=15, leading=19, alignment=TA_CENTER)
    s_sec = ParagraphStyle("s", fontName=bold, fontSize=14, leading=18, alignment=TA_CENTER)
    s_lab = ParagraphStyle("l", fontName=reg, fontSize=11.5, leading=14)
    s_cell = ParagraphStyle("c", fontName=reg, fontSize=11, leading=13.5)
    s_cell_c = ParagraphStyle("cc", parent=s_cell, alignment=TA_CENTER)
    s_head = ParagraphStyle("h", fontName=bold, fontSize=11.5, leading=14)
    s_head_c = ParagraphStyle("hc", parent=s_head, alignment=TA_CENTER)
    s_note = ParagraphStyle("n", fontName=reg, fontSize=10.5, leading=13, alignment=TA_LEFT)

    def P(text, style):
        return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), style)

    story = []
    title = (data.get("title") or "").strip()
    if title:
        story += [Paragraph(f"<u>{escape(title)}</u>", s_title), Spacer(1, 18)]

    # a row with no value is left out (batch no / CAS / quantity are optional)
    rows = [[r.get("label") or "", r.get("value") or ""] for r in (data.get("info") or [])
            if str(r.get("value") or "").strip()]
    mfg, exp = coa_dates(data, today)
    if data.get("show_mfg", True) and mfg:
        rows.append([data.get("mfg_label") or "MFG.DATE", mfg])
    if data.get("show_exp", True) and exp:
        rows.append([data.get("exp_label") or "EXP.DATE", exp])
    if rows:
        lab_w = min(170, max(90, max(pdfmetrics.stringWidth(str(r[0]) + ":", reg, 11.5) for r in rows) + 18))
        t = Table([[P((r[0] + ":") if r[0] and not str(r[0]).rstrip().endswith(":") else r[0], s_lab), P(r[1], s_lab)]
                   for r in rows], colWidths=[lab_w, doc.width - lab_w], hAlign="LEFT")
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        story += [t, Spacer(1, 26)]

    for sec in (data.get("sections") or []):
        cols = [c for c in (sec.get("columns") or []) if c is not None] or ["Parameters", "Specification", "Results"]
        n = len(cols)
        body = [r for r in (sec.get("rows") or []) if any(str(x or "").strip() for x in r)]
        if not body and not sec.get("title"):
            continue
        if sec.get("title"):
            story += [Paragraph(f"<u>{escape(sec['title'])}</u>", s_sec), Spacer(1, 12)]
        if body:
            first_w = doc.width * (0.33 if n == 3 else 0.4 if n == 2 else 0.3)
            rest = (doc.width - first_w) / max(1, n - 1)
            widths = [first_w] + [rest] * (n - 1)
            if n == 3:  # match the sample: wide spec column, narrow results column
                widths = [doc.width * 0.33, doc.width * 0.41, doc.width * 0.26]
            data_rows = [[P(c, s_head if i == 0 or i == n - 1 else s_head_c) for i, c in enumerate(cols)]]
            for r in body:
                r = (list(r) + [""] * n)[:n]
                data_rows.append([P(v, s_cell if i == 0 or i == n - 1 else s_cell_c) for i, v in enumerate(r)])
            t = Table(data_rows, colWidths=widths, repeatRows=1)
            t.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.6, colors.HexColor("#A6A6A6")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
                ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]))
            story += [t, Spacer(1, 10)]
        story.append(Spacer(1, 8))

    note = (data.get("note") or "").strip()
    if note:
        story.append(P(note, s_note))
    if not story:
        story.append(P(" ", s_note))
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()
