"""Draw the app icons (original, simple): a note and three "lyric lines" on blue.

Run: uv run --with pillow python scripts/make_icons.py
Writes static/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
SIZE = 1024  # draw large, scale down
TOP, BOTTOM = (64, 129, 236), (36, 84, 196)  # blue gradient
WHITE = (255, 255, 255, 255)
SOFT = (255, 255, 255, 170)


def background(size: int, rounded: bool) -> Image.Image:
    grad = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(grad)
    for y in range(size):
        f = y / (size - 1)
        draw.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * f) for a, b in zip(TOP, BOTTOM)) + (255,))
    if not rounded:
        return grad
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, mask=mask)
    return out


def motif(img: Image.Image, scale: float) -> None:
    """Note on the left, lyric lines on the right; `scale` shrinks it toward the center (maskable safe zone)."""
    d = ImageDraw.Draw(img)
    s = img.size[0]

    def p(x, y):  # design coordinates (0..1024) -> image, scaled around the center
        return (s / 2 + (x - 512) * scale * s / SIZE, s / 2 + (y - 512) * scale * s / SIZE)

    def box(x0, y0, x1, y1):
        (a, b), (c, e) = p(x0, y0), p(x1, y1)
        return [a, b, c, e]

    # eighth note: head, stem, flag
    d.ellipse(box(214, 610, 404, 760), fill=WHITE)
    d.rectangle(box(366, 270, 404, 690), fill=WHITE)
    d.polygon([p(404, 270), p(520, 330), p(520, 410), p(404, 360)], fill=WHITE)
    # lyric lines: bright current line between two dim ones
    r = 22 * scale * s / SIZE
    d.rounded_rectangle(box(560, 380, 830, 424), radius=r, fill=SOFT)
    d.rounded_rectangle(box(560, 492, 860, 548), radius=r, fill=WHITE)
    d.rounded_rectangle(box(560, 616, 780, 660), radius=r, fill=SOFT)


def make(name: str, size: int, rounded: bool, scale: float) -> None:
    img = background(SIZE, rounded)
    motif(img, scale)
    img.resize((size, size), Image.LANCZOS).save(OUT / name)


OUT.mkdir(parents=True, exist_ok=True)
make("icon-192.png", 192, rounded=True, scale=1.0)
make("icon-512.png", 512, rounded=True, scale=1.0)
make("maskable-512.png", 512, rounded=False, scale=0.78)  # Android crops to a circle/squircle
make("apple-touch-icon.png", 180, rounded=False, scale=0.92)  # iOS rounds the corners itself
print("icons written to", OUT)
