"""Generate Peer's app icons from build/icon-source.png.

    uv run --with pillow python scripts/make-icons.py      (macOS: needs iconutil)

The source is the artwork on an opaque black background. This script finds the rounded square,
makes everything outside it transparent, and writes:
  build/icon.icns       macOS: Apple's icon grid (824 px body on a 1024 canvas) with a soft shadow
  build/icon.png        the 1024 px macOS-layout image (also used for the README/website)
  build/icons/NxN.png   Linux: tighter padding, sizes 16-1024 (electron-builder's linux.icon dir)
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SRC = BUILD / "icon-source.png"
THRESHOLD = 25  # sum of RGB; the background is pure black, the square's ground is ~(8, 21, 17)


def find_square(im: Image.Image):
    """Bounding box and corner radius of the rounded square, measured on the image itself."""
    px = im.load()
    w, h = im.size
    lit = lambda x, y: sum(px[x, y]) > THRESHOLD
    left = next(x for x in range(w) if lit(x, h // 2))
    right = next(x for x in range(w - 1, -1, -1) if lit(x, h // 2))
    top = next(y for y in range(h) if lit(w // 2, y))
    bottom = next(y for y in range(h - 1, -1, -1) if lit(w // 2, y))
    # A rounded corner of radius r starts r * (1 - 1/sqrt 2) in along the diagonal. Average all four.
    insets = []
    for x0, y0, dx, dy in ((left, top, 1, 1), (right, top, -1, 1), (left, bottom, 1, -1), (right, bottom, -1, -1)):
        insets.append(next(i for i in range(min(w, h) // 2) if lit(x0 + dx * i, y0 + dy * i)))
    radius = (sum(insets) / len(insets)) / (1 - 0.5**0.5)
    return (left, top, right + 1, bottom + 1), radius


def rounded_mask(size: int, radius: float, scale: int = 4) -> Image.Image:
    """Anti-aliased rounded-square mask (drawn large, then downsampled)."""
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=radius * scale, fill=255)
    return big.resize((size, size), Image.LANCZOS)


EDGE_INSET = 3  # px; the source's outermost pixels blend into its black background (a dark fringe)


def cutout(src: Image.Image) -> Image.Image:
    """The rounded square alone, transparent outside, as a square RGBA image."""
    box, radius = find_square(src)
    box = (box[0] + EDGE_INSET, box[1] + EDGE_INSET, box[2] - EDGE_INSET, box[3] - EDGE_INSET)
    radius -= EDGE_INSET
    side = min(box[2] - box[0], box[3] - box[1])
    square = src.crop((box[0], box[1], box[0] + side, box[1] + side)).convert("RGBA")
    square.putalpha(rounded_mask(side, radius))
    return square


def place(art: Image.Image, canvas: int, body: int, shadow: bool) -> Image.Image:
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    body_img = art.resize((body, body), Image.LANCZOS)
    offset = (canvas - body) // 2
    if shadow:
        # Apple's template: a soft shadow below the body (scaled from 1024: 28 px blur, 12 px down, 50%).
        k = canvas / 1024
        alpha = body_img.getchannel("A").point(lambda a: a * 0.5)
        shade = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        shade_layer = Image.new("RGBA", (body, body), (0, 0, 0, 255))
        shade_layer.putalpha(alpha)
        shade.paste(shade_layer, (offset, offset + round(12 * k)), shade_layer)
        shade = shade.filter(ImageFilter.GaussianBlur(28 * k / 2))
        out = Image.alpha_composite(out, shade)
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    layer.paste(body_img, (offset, offset))
    return Image.alpha_composite(out, layer)


def main() -> int:
    src = Image.open(SRC).convert("RGB")
    art = cutout(src)

    # macOS: Apple's grid puts an 824 px body on a 1024 px canvas.
    mac = place(art, 1024, 824, shadow=True)
    mac.save(BUILD / "icon.png")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            mac.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            mac.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)

    # Linux: launchers show icons as-is, so keep only a small margin.
    linux_dir = BUILD / "icons"
    shutil.rmtree(linux_dir, ignore_errors=True)
    linux_dir.mkdir()
    linux = place(art, 1024, 944, shadow=False)
    for size in (16, 32, 48, 64, 128, 256, 512, 1024):
        linux.resize((size, size), Image.LANCZOS).save(linux_dir / f"{size}x{size}.png")

    print(f"square {find_square(src)[0]}, radius {find_square(src)[1]:.0f}px -> build/icon.icns, build/icon.png, build/icons/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
