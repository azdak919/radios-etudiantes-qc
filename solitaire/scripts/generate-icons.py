#!/usr/bin/env python3
"""Génère les PNG PWA / favicons Solitaire — joker 🃏 (Twemoji), style Le Radar / Pomodoro."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
# Same Twemoji joker as Le Radar masthead (assets/emoji/joker.png)
EMOJI_PNG = ROOT.parent / "assets" / "emoji" / "joker.png"
if not EMOJI_PNG.exists():
    EMOJI_PNG = ROOT / "assets" / "twemoji-joker.png"
BG = (26, 24, 22, 255)

OUTPUTS = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "favicon-96x96.png": 96,
    "favicon-128x128.png": 128,
    "apple-touch-icon-120x120.png": 120,
    "apple-touch-icon-152x152.png": 152,
    "apple-touch-icon-180x180.png": 180,
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-192-maskable.png": 192,
    "icon-512.png": 512,
    "icon-512-maskable.png": 512,
}


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def emoji_ratio(size: int, *, maskable: bool) -> float:
    """Larger glyph at tiny sizes so bookmarks stay readable (🃏 not a red blob)."""
    if maskable:
        return 0.52
    if size <= 16:
        return 0.78
    if size <= 32:
        return 0.72
    return 0.66


def render_icon(size: int, *, maskable: bool = False) -> Image.Image:
    radius = max(3, round(size * 0.227))
    emoji_src = Image.open(EMOJI_PNG).convert("RGBA")

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base = Image.new("RGBA", (size, size), BG)
    base.putalpha(rounded_mask(size, radius))
    canvas.alpha_composite(base)

    ratio = emoji_ratio(size, maskable=maskable)
    emoji_size = max(10, round(size * ratio))
    emoji = emoji_src.resize((emoji_size, emoji_size), Image.Resampling.LANCZOS)
    offset = ((size - emoji_size) // 2, (size - emoji_size) // 2)
    canvas.alpha_composite(emoji, offset)
    return canvas


def main() -> None:
    if not EMOJI_PNG.exists():
        raise SystemExit(f"Emoji asset not found: {EMOJI_PNG}")

    for name, size in OUTPUTS.items():
        maskable = "maskable" in name
        out = ROOT / name
        render_icon(size, maskable=maskable).save(out, format="PNG", optimize=True)
        print(f"✓ {name}")

    ico_path = ROOT / "favicon.ico"
    # Multi-size ICO: browsers often pull 16/32 for the bookmark bar
    imgs = [render_icon(16), render_icon(32)]
    imgs[0].save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32)],
        append_images=[imgs[1]],
    )
    print("✓ favicon.ico")


if __name__ == "__main__":
    main()
