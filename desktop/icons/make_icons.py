#!/usr/bin/env python3
"""Regenerates the app icons. Run from desktop/: `python3 icons/make_icons.py`.

Draws one 1024px mark and downscales it, so every size is the same picture.
"""

from PIL import Image, ImageDraw

SIZE = 1024
BG = (15, 20, 28)
UP = (62, 207, 164)
DOWN = (224, 100, 92)
WICK = 26
BODY = 122

# (centre, wick top, wick bottom, body top, body bottom, rising)
CANDLES = [
    (206, 300, 760, 430, 700, False),
    (402, 250, 690, 330, 610, True),
    (622, 330, 812, 470, 762, False),
    (818, 200, 620, 280, 520, True),
]


def draw(size: int) -> Image.Image:
    scale = size / SIZE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(180 * scale)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    def px(value: float) -> int:
        return int(round(value * scale))

    for centre, wick_top, wick_bottom, body_top, body_bottom, rising in CANDLES:
        colour = UP if rising else DOWN
        half = px(WICK / 2)
        draw.rectangle(
            [px(centre) - half, px(wick_top), px(centre) + half, px(wick_bottom)],
            fill=colour,
        )
        left, right = px(centre - BODY / 2), px(centre + BODY / 2)
        draw.rounded_rectangle(
            [left, px(body_top), right, px(body_bottom)],
            radius=px(16),
            fill=colour,
        )
    return image


def main() -> None:
    base = draw(SIZE)
    for name, size in [("icon.png", 512), ("128x128.png", 128), ("128x128@2x.png", 256), ("32x32.png", 32)]:
        base.resize((size, size), Image.Resampling.LANCZOS).save(f"icons/{name}")
    base.save(
        "icons/icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icons written")


if __name__ == "__main__":
    main()
