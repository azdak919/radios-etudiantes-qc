#!/usr/bin/env python3
"""Génère les PNG PWA (192 / 512) à partir de l’emoji journal 📰."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONT = Path("/usr/share/fonts/google-noto-color-emoji-fonts/Noto-COLRv1.ttf")
EMOJI = "📰"
BG = (108, 33, 99, 255)
SIZES = (192, 512)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render_icon(size: int) -> Image.Image:
    radius = max(12, round(size * 0.227))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base = Image.new("RGBA", (size, size), BG)
    base.putalpha(rounded_mask(size, radius))
    canvas.alpha_composite(base)

    font = ImageFont.truetype(str(FONT), int(size * 0.55))
    draw = ImageDraw.Draw(canvas)
    bbox = draw.textbbox((0, 0), EMOJI, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), EMOJI, font=font, embedded_color=True)
    return canvas


def main() -> None:
    if not FONT.exists():
        raise SystemExit(f"Emoji font not found: {FONT}")

    for size in SIZES:
        out = ASSETS / f"icon-{size}.png"
        render_icon(size).save(out, format="PNG", optimize=True)
        print(f"✓ {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()