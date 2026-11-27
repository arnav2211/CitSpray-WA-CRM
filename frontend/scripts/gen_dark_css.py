"""Generate src/dark.css: dark-mode overrides for the light Tailwind classes used in the app.

  python frontend/scripts/gen_dark_css.py        (re-run after adding new light colours)

The app was built light-only with hard-coded classes (bg-white, text-gray-700, bg-[#EAF1FF] ...).
Under <html class="dark"> each of those gets a dark counterpart: surfaces go dark, dark text goes
light, pale tinted backgrounds become a deep tint of the same hue. Bright brand colours (buttons,
badges) are left alone."""
from __future__ import annotations

import colorsys
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
OUT = SRC / "dark.css"

BASE = (17, 24, 39)        # #111827 surface
PAGE = "#0B0F17"

GRAY_BG = {"white": "#111827", "gray-50": "#0F1623", "gray-100": "#1A2232", "gray-200": "#263042", "gray-300": "#334155",
           "slate-50": "#0F1623", "slate-100": "#1A2232", "slate-200": "#263042", "neutral-50": "#0F1623", "neutral-100": "#1A2232",
           "zinc-50": "#0F1623", "zinc-100": "#1A2232", "stone-50": "#0F1623", "stone-100": "#1A2232"}
GRAY_TEXT = {"black": "#F3F4F6", "gray-900": "#F3F4F6", "gray-800": "#E5E7EB", "gray-700": "#D1D5DB", "gray-600": "#B4BDCB",
             "gray-500": "#9AA4B5", "gray-400": "#7F8A9C", "gray-300": "#5B6576", "slate-900": "#F3F4F6", "slate-800": "#E5E7EB",
             "slate-700": "#D1D5DB", "slate-600": "#B4BDCB", "slate-500": "#9AA4B5", "neutral-900": "#F3F4F6", "neutral-800": "#E5E7EB",
             "neutral-700": "#D1D5DB", "neutral-600": "#B4BDCB", "neutral-500": "#9AA4B5", "zinc-900": "#F3F4F6", "zinc-700": "#D1D5DB",
             "zinc-500": "#9AA4B5", "stone-700": "#D1D5DB", "stone-500": "#9AA4B5"}
GRAY_BORDER = {"white": "#263042", "gray-100": "#1E2735", "gray-200": "#263042", "gray-300": "#334155", "gray-400": "#475569",
               "slate-200": "#263042", "slate-300": "#334155", "black": "#475569"}
TW = {  # tailwind hues used for pale backgrounds / dark text
    "red": (239, 68, 68), "orange": (249, 115, 22), "amber": (245, 158, 11), "yellow": (234, 179, 8), "lime": (132, 204, 22),
    "green": (34, 197, 94), "emerald": (16, 185, 129), "teal": (20, 184, 166), "cyan": (6, 182, 212), "sky": (14, 165, 233),
    "blue": (59, 130, 246), "indigo": (99, 102, 241), "violet": (139, 92, 246), "purple": (168, 85, 247), "fuchsia": (217, 70, 239),
    "pink": (236, 72, 153), "rose": (244, 63, 94),
}
TW_LIGHT_TEXT = {"red": "#FCA5A5", "orange": "#FDBA74", "amber": "#FCD34D", "yellow": "#FDE047", "lime": "#BEF264", "green": "#86EFAC",
                 "emerald": "#6EE7B7", "teal": "#5EEAD4", "cyan": "#67E8F9", "sky": "#7DD3FC", "blue": "#93C5FD", "indigo": "#A5B4FC",
                 "violet": "#C4B5FD", "purple": "#D8B4FE", "fuchsia": "#F0ABFC", "pink": "#F9A8D4", "rose": "#FDA4AF"}

VARIANTS = {"": "", "hover:": ":hover", "focus:": ":focus", "active:": ":active"}
TOKEN = re.compile(r"(?<![\w:-])((?:hover:|focus:|active:)?)((?:bg|text|border(?:-[trblxy])?|divide|from|to|via|ring)-[\w\[\]#/.-]+)")


def hexrgb(h: str):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hexs(rgb) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02X}" for c in rgb)


def lum(rgb) -> float:
    return colorsys.rgb_to_hls(*(c / 255 for c in rgb))[1]


def mix(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


def pale_to_dark(rgb):
    """a pale tint (#EAF1FF) -> a deep tint of the same hue on the dark surface"""
    h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
    if s < 0.12:
        return GRAY_BG["gray-100"]
    r, g, b = colorsys.hls_to_rgb(h, 0.5, min(1.0, s))
    return hexs(mix(BASE, (r * 255, g * 255, b * 255), 0.2))


def dark_to_light(rgb):
    hh, ll, ss = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
    if ss < 0.15:
        return "#E5E7EB"
    r, g, b = colorsys.hls_to_rgb(hh, 0.72, min(0.7, ss))
    return hexs((r * 255, g * 255, b * 255))


def esc(cls: str) -> str:
    return re.sub(r"([:\[\]#/.%])", r"\\\1", cls)


def rule_for(prop_cls: str):
    """(css property, value) for one class, or None to leave it."""
    m = re.fullmatch(r"(bg|text|border(?:-[trblxy])?|divide)-(.+)", prop_cls)
    if not m:
        return None
    kind, val = m.groups()
    alpha = None
    if "/" in val and not val.startswith("["):
        val, alpha = val.split("/", 1)
    hexv = None
    am = re.fullmatch(r"\[#([0-9a-fA-F]{3,6})\](?:/(\d+))?", m.group(2))
    if am:
        hexv, alpha = hexrgb(am.group(1)), am.group(2)
        if hexv is None:
            return None
    if kind == "bg":
        if alpha is not None:
            if not hexv and val == "white":
                return ("background-color", f"rgba(17,24,39,{int(alpha) / 100:.2f})")
            return None   # translucent tints already work on dark
        if hexv:
            return ("background-color", pale_to_dark(hexv)) if lum(hexv) > 0.86 else None
        if val in GRAY_BG:
            return ("background-color", GRAY_BG[val])
        hm = re.fullmatch(r"([a-z]+)-(50|100|200)", val)
        if hm and hm.group(1) in TW:
            t = {"50": 0.14, "100": 0.2, "200": 0.28}[hm.group(2)]
            return ("background-color", hexs(mix(BASE, TW[hm.group(1)], t)))
        return None
    if kind == "text":
        if alpha is not None:
            return None
        if hexv:
            return ("color", dark_to_light(hexv)) if lum(hexv) < 0.36 else None
        if val in GRAY_TEXT:
            return ("color", GRAY_TEXT[val])
        hm = re.fullmatch(r"([a-z]+)-(600|700|800|900)", val)
        if hm and hm.group(1) in TW:
            return ("color", TW_LIGHT_TEXT[hm.group(1)])
        return None
    # borders / dividers
    prop = {"border": "border-color", "border-t": "border-top-color", "border-b": "border-bottom-color", "border-l": "border-left-color",
            "border-r": "border-right-color", "border-x": "border-left-color", "border-y": "border-top-color", "divide": "border-color"}[kind]
    if alpha is not None and not hexv:
        return None
    if hexv:
        return (prop, pale_to_dark(hexv)) if lum(hexv) > 0.86 else None
    if val in GRAY_BORDER:
        return (prop, GRAY_BORDER[val])
    hm = re.fullmatch(r"([a-z]+)-(100|200|300)", val)
    if hm and hm.group(1) in TW:
        return (prop, hexs(mix(BASE, TW[hm.group(1)], 0.45)))
    return None


def main() -> None:
    found = set()
    for f in SRC.rglob("*"):
        if f.suffix in (".js", ".jsx") and "node_modules" not in f.parts:
            for m in TOKEN.finditer(f.read_text(encoding="utf-8", errors="ignore")):
                found.add((m.group(1), m.group(2)))
    out = [__doc__.replace("*/", "").join(["/* ", " */"]), "",
           f"html.dark body {{ background: {PAGE}; color: #E5E7EB; }}",
           "html.dark h1, html.dark h2, html.dark h3, html.dark h4, html.dark h5 { color: #F3F4F6; }",
           "html.dark input:not([type=checkbox]):not([type=radio]):not([type=range]), html.dark textarea, html.dark select {"
           " background-color: #0F1623; color: #E5E7EB; border-color: #334155; }",
           "html.dark input::placeholder, html.dark textarea::placeholder { color: #6B7587; }",
           "html.dark .kbd { background: #1A2232; border-color: #334155; color: #D1D5DB; }",
           "html.dark ::-webkit-scrollbar-thumb { background: #334155; }",
           "html.dark ::-webkit-scrollbar-thumb:hover { background: #475569; }",
           "html.dark .login-grid-bg { background-color: #0B0F17; background-image: linear-gradient(#1A2232 1px, transparent 1px), linear-gradient(90deg, #1A2232 1px, transparent 1px); }",
           "html.dark .wa-bubble-in { background: #1A2232; color: #E5E7EB; }",
           "html.dark { --background: 222 30% 7%; --foreground: 220 14% 91%; --card: 221 39% 11%; --card-foreground: 220 14% 91%;"
           " --popover: 221 39% 11%; --popover-foreground: 220 14% 91%; --secondary: 218 31% 15%; --secondary-foreground: 220 14% 91%;"
           " --muted: 218 31% 15%; --muted-foreground: 218 13% 64%; --accent: 218 31% 15%; --accent-foreground: 220 14% 91%;"
           " --border: 217 27% 21%; --input: 217 27% 21%; --primary: 221 83% 62%; --ring: 221 83% 62%; }",
           "html.dark img, html.dark video, html.dark canvas { color-scheme: light; }",
           "/* links/buttons in the brand blue stay readable on dark */",
           ""]
    n = 0
    for variant, cls in sorted(found):
        r = rule_for(cls)
        if not r:
            continue
        prop, value = r
        full = variant + cls
        sel = f"html.dark .{esc(full)}{VARIANTS[variant]}"
        if cls.startswith("divide-"):
            sel = f"html.dark .{esc(full)}{VARIANTS[variant]} > :not([hidden]) ~ :not([hidden])"
        out.append(f"{sel} {{ {prop}: {value}; }}")
        n += 1
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {OUT} with {n} rules")


if __name__ == "__main__":
    main()
