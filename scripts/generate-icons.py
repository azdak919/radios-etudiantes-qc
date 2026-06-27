#!/usr/bin/env python3
"""Génère les PNG PWA (32 / 192 / 512) — antenne parabolique 📡 (Twemoji)."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
EMOJI_PNG = ASSETS / "twemoji-satellite.png"
BG = (10, 10, 11, 255)
SIZES = (32, 192, 512)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render_icon(size: int) -> Image.Image:
    radius = max(4, round(size * 0.227))
    emoji_src = Image.open(EMOJI_PNG).convert("RGBA")

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base = Image.new("RGBA", (size, size), BG)
    base.putalpha(rounded_mask(size, radius))
    canvas.alpha_composite(base)

    emoji_size = max(16, round(size * 0.62))
    emoji = emoji_src.resize((emoji_size, emoji_size), Image.Resampling.LANCZOS)
    offset = ((size - emoji_size) // 2, (size - emoji_size) // 2)
    canvas.alpha_composite(emoji, offset)
    return canvas


def main() -> None:
    if not EMOJI_PNG.exists():
        raise SystemExit(f"Emoji asset not found: {EMOJI_PNG}")

    for size in SIZES:
        out = ASSETS / (f"icon-{size}.png" if size != 32 else "icon-32.png")
        render_icon(size).save(out, format="PNG", optimize=True)
        print(f"✓ {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()