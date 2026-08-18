#!/usr/bin/env python3
"""
Generate assets/og-image.png — the Open Graph / social preview card.

    python tools/make-og-image.py

Kept in the repo so the card can be regenerated rather than being an opaque
binary someone has to recreate by hand. Requires Pillow:

    pip install Pillow

Fonts are resolved from a preference list per role and fall back to whatever
the platform offers, so the script still produces a usable card on a machine
that lacks the Ubuntu family. Ubuntu Mono, when present, is used for the
terminal mock because that is the one place the exact typeface matters.

Output is 1200x630 — the size Open Graph, Twitter/X and Slack all render
without cropping.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - user-facing guidance
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "og-image.png"

W, H = 1200, 630
SS = 2  # supersampling factor: draw big, downscale for antialiasing

# Yaru palette, matching css/base/tokens.css
AUBERGINE = (44, 0, 30)
PURPLE = (119, 41, 83)
ORANGE = (233, 84, 32)
WHITE = (255, 255, 255)
TERM_BG = (48, 10, 36)
TERM_GREEN = (38, 162, 105)
TERM_BLUE = (42, 123, 222)
TERM_GREY = (208, 207, 204)
TERM_DIM = (94, 92, 100)
TERM_YELLOW = (233, 173, 12)

FONT_DIRS = [
    Path("C:/Windows/Fonts"),
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
    Path.home() / ".fonts",
    Path("/System/Library/Fonts"),
    Path("/Library/Fonts"),
]

# Per role, in order of preference.
FONT_CHOICES = {
    "display": ["Ubuntu-Bold.ttf", "seguisb.ttf", "segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"],
    "body": ["Ubuntu-Regular.ttf", "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"],
    # Korean text needs a face with Hangul coverage.
    "korean": ["malgun.ttf", "NanumGothic.ttf", "AppleSDGothicNeo.ttc", "NotoSansCJK-Regular.ttc", "arial.ttf"],
    "mono": ["UbuntuMono-Regular.ttf", "consola.ttf", "DejaVuSansMono.ttf", "cour.ttf"],
}


def find_font(role: str, size: int) -> ImageFont.FreeTypeFont:
    """Load the first available face for `role`, else Pillow's default."""
    for name in FONT_CHOICES[role]:
        for directory in FONT_DIRS:
            candidate = directory / name
            if candidate.exists():
                try:
                    return ImageFont.truetype(str(candidate), size)
                except OSError:
                    continue
        # Also let fontconfig/Windows resolve a bare name.
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def lerp(a, b, t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(w: int, h: int) -> Image.Image:
    """
    Aubergine -> purple -> orange on the diagonal.

    Built at low resolution and upscaled: a gradient has no high-frequency
    detail, so this is visually identical to a per-pixel loop and far quicker.
    """
    cw, ch = 64, 34
    small = Image.new("RGB", (cw, ch))
    px = small.load()
    for y in range(ch):
        for x in range(cw):
            t = (x / (cw - 1) + y / (ch - 1)) / 2
            px[x, y] = lerp(AUBERGINE, PURPLE, t / 0.55) if t <= 0.55 else lerp(PURPLE, ORANGE, (t - 0.55) / 0.45)
    return small.resize((w, h), Image.BICUBIC)


def radial_glow(w: int, h: int, cx: float, cy: float, radius: float, peak: int) -> Image.Image:
    """A soft white radial highlight, returned as an 'L' alpha mask."""
    cw, ch = 96, 50
    small = Image.new("L", (cw, ch))
    px = small.load()
    fx, fy = cx * cw, cy * ch
    r = radius * cw
    for y in range(ch):
        for x in range(cw):
            d = (((x - fx) ** 2 + ((y - fy) * (cw / ch)) ** 2) ** 0.5) / r
            px[x, y] = max(0, round(peak * (1 - d) ** 2)) if d < 1 else 0
    return small.resize((w, h), Image.BICUBIC)


def circle_of_friends(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, colour) -> None:
    """
    The Ubuntu mark: three dots at 0/120/240 degrees joined by an arc that
    breaks at each dot.
    """
    width = max(2, round(r * 0.27))
    dot_r = max(2, round(r * 0.35))
    box = (cx - r, cy - r, cx + r, cy + r)
    for start in (-50, 70, 190):
        draw.arc(box, start, start + 100, fill=colour, width=width)
    import math

    for angle in (0, 120, 240):
        rad = math.radians(angle)
        dx, dy = cx + r * math.cos(rad), cy + r * math.sin(rad)
        draw.ellipse((dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r), fill=colour)


def rounded_panel(img: Image.Image, box, radius: int, fill, shadow=True) -> None:
    """Draw a rounded rectangle with an optional soft drop shadow."""
    if shadow:
        from PIL import ImageFilter

        x0, y0, x1, y1 = box
        pad = 40
        layer = Image.new("L", (img.width, img.height), 0)
        ImageDraw.Draw(layer).rounded_rectangle((x0, y0 + 10, x1, y1 + 14), radius, fill=150)
        layer = layer.filter(ImageFilter.GaussianBlur(pad // 2))
        img.paste(Image.new("RGB", img.size, (0, 0, 0)), (0, 0), layer)
    ImageDraw.Draw(img).rounded_rectangle(box, radius, fill=fill)


def build() -> Image.Image:
    img = diagonal_gradient(W * SS, H * SS)
    img.paste(
        Image.new("RGB", img.size, WHITE),
        (0, 0),
        radial_glow(W * SS, H * SS, 0.78, 0.16, 0.85, 52),
    )

    draw = ImageDraw.Draw(img)

    # Concentric rings, echoing the default wallpaper. Drawn on their own layer
    # and composited at low opacity: at full strength they cut across the
    # headline and read as content rather than as texture.
    rings = Image.new("L", img.size, 0)
    rings_draw = ImageDraw.Draw(rings)
    rcx, rcy = int(W * SS * 0.80), int(H * SS * 0.20)
    for radius in (150, 250, 360, 470, 580):
        rr = radius * SS
        rings_draw.ellipse((rcx - rr, rcy - rr, rcx + rr, rcy + rr), outline=42, width=2 * SS)
    img.paste(Image.new("RGB", img.size, WHITE), (0, 0), rings)

    circle_of_friends(draw, 130 * SS, 108 * SS, 34 * SS, WHITE)

    f_brand = find_font("display", 26 * SS)
    f_title = find_font("display", 74 * SS)
    f_ko = find_font("korean", 29 * SS)
    f_en = find_font("body", 23 * SS)
    f_mono = find_font("mono", 21 * SS)
    f_url = find_font("body", 22 * SS)

    draw.text((188 * SS, 92 * SS), "JTech-CO", font=f_brand, fill=(255, 255, 255))
    draw.text((96 * SS, 168 * SS), "Ubuntu AI Desktop", font=f_title, fill=WHITE)
    draw.text(
        (98 * SS, 266 * SS),
        "브라우저에서 그대로 도는 Ubuntu 24.04 LTS 데스크톱",
        font=f_ko,
        fill=(255, 255, 255),
    )
    draw.text(
        (98 * SS, 310 * SS),
        "A full Ubuntu desktop in your browser — no install, no server, no build step.",
        font=f_en,
        fill=(238, 226, 232),
    )

    # --- terminal mock ---
    tx, ty, tw, th = 96 * SS, 366 * SS, 1008 * SS, 190 * SS
    rounded_panel(img, (tx, ty, tx + tw, ty + th), 14 * SS, TERM_BG)
    draw = ImageDraw.Draw(img)
    # Header bar: rounded on top, square where it meets the body.
    draw.rounded_rectangle((tx, ty, tx + tw, ty + 38 * SS), 14 * SS, fill=(60, 58, 55))
    draw.rectangle((tx, ty + 24 * SS, tx + tw, ty + 38 * SS), fill=(60, 58, 55))

    f_hdr = find_font("body", 15 * SS)
    title = "ubuntu@ubuntu-ai: ~"
    tw_px = draw.textlength(title, font=f_hdr)
    draw.text((tx + tw / 2 - tw_px / 2, ty + 10 * SS), title, font=f_hdr, fill=(226, 222, 220))
    # Right to left: close (orange) is the rightmost button on Yaru, then
    # maximize, then minimize — the same order the emulator's own chrome uses.
    for i, colour in enumerate((ORANGE, (220, 220, 220), (220, 220, 220))):
        cx = tx + tw - (26 + i * 26) * SS
        r = 7 * SS
        draw.ellipse((cx - r, ty + 19 * SS - r, cx + r, ty + 19 * SS + r), fill=colour)

    def line(y: int, segments) -> None:
        x = tx + 26 * SS
        for text, colour in segments:
            draw.text((x, y), text, font=f_mono, fill=colour)
            x += draw.textlength(text, font=f_mono)

    prompt = [
        ("ubuntu@ubuntu-ai", TERM_GREEN),
        (":", TERM_GREY),
        ("~", TERM_BLUE),
        ("$ ", TERM_GREY),
    ]
    line(ty + 60 * SS, prompt + [("ls /etc | wc -l", WHITE)])
    line(ty + 90 * SS, [("36", TERM_GREY)])
    # Ubuntu Mono carries no Hangul, so this comment stays in English rather
    # than rendering as tofu boxes. The Korean copy lives in the subtitle,
    # which is set in a font that does cover it.
    line(ty + 120 * SS, prompt + [("neofetch", WHITE), ("   # reads the real CPU, GPU and RAM", TERM_DIM)])
    line(
        ty + 150 * SS,
        [("Ubuntu 24.04.1 LTS  ·  200 commands  ·  10 apps  ·  real bash pipeline", TERM_YELLOW)],
    )

    draw.text((96 * SS, 578 * SS), "jtech-co.github.io/Ubuntu-AI-Desktop", font=f_url, fill=(255, 226, 214))

    return img.resize((W, H), Image.LANCZOS)


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    card = build()
    card.save(OUT, "PNG", optimize=True)
    size_kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT.relative_to(ROOT)}  {card.width}x{card.height}  {size_kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
