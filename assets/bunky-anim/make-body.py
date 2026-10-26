"""Builds bunky-body.png: bunky.png with the eyes, brows and mouth painted out,
upscaled 4x, so index.html can draw an animatable face over it.

No generative tools: the painted-out areas are filled by diffusion (each pixel
repeatedly averaged from its neighbours, coarse-to-fine) plus crayon grain
copied from nearby untouched body pixels.

    python3 make-body.py   # run from this folder; writes bunky-body.png
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'bunky.png'
OUT = HERE / 'bunky-body.png'
SCALE = 4

# Feature geometry, in the 294x270 coordinates the SVG face uses (3x the PNG).
EYES = [(92, 145), (192, 145)]
EYE_MASK_R = 41  # the SVG eyes (r=38 + stroke) always cover this
BROW_BOXES = [(72, 75, 131, 112), (145, 80, 222, 98)]
MOUTH_BOX = (110, 184, 177, 208)
# The right brow's tail pokes out past the silhouette; cut it off entirely.
TRIM_BOX = (210, 81, 231, 90)


def face_coords(h, w):
    """Pixel centers of the source PNG, in face coordinates."""
    ys, xs = np.mgrid[0:h, 0:w]
    return (xs + 0.5) * 3, (ys + 0.5) * 3


def masks(rgba):
    h, w = rgba.shape[:2]
    lum = rgba[..., :3] @ np.array([0.3, 0.59, 0.11])
    fx, fy = face_coords(h, w)
    m = np.zeros((h, w), bool)
    for cx, cy in EYES:
        m |= (fx - cx) ** 2 + (fy - cy) ** 2 <= EYE_MASK_R ** 2
    for x0, y0, x1, y1 in BROW_BOXES + [MOUTH_BOX]:
        m |= (fx >= x0) & (fx <= x1) & (fy >= y0) & (fy <= y1) & (lum < 130)
    # Grow by one pixel to take the anti-aliased fringe too.
    grown = m.copy()
    grown[1:] |= m[:-1]; grown[:-1] |= m[1:]
    grown[:, 1:] |= m[:, :-1]; grown[:, :-1] |= m[:, 1:]
    return grown


def diffuse(img, hole, iters=400):
    """Fill hole pixels by repeated neighbour averaging, starting from a
    coarse fill so large holes don't stay flat in the middle."""
    known = ~hole
    out = img.copy()
    # Coarse seed: nearest-known average at 1/4 scale.
    small_w, small_h = img.shape[1] // 4 + 1, img.shape[0] // 4 + 1
    seed = np.zeros((small_h, small_w, 3)); cnt = np.zeros((small_h, small_w, 1))
    ys, xs = np.nonzero(known)
    np.add.at(seed, (ys // 4, xs // 4), img[ys, xs])
    np.add.at(cnt, (ys // 4, xs // 4), 1)
    seed = np.where(cnt > 0, seed / np.maximum(cnt, 1), 0)
    have = cnt[..., 0] > 0
    for _ in range(50):
        if have.all():
            break
        acc = np.zeros_like(seed); n = np.zeros(have.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s = np.roll(seed, (dy, dx), (0, 1)); hv = np.roll(have, (dy, dx), (0, 1))
            acc += s * hv[..., None]; n += hv
        newly = ~have & (n > 0)
        seed[newly] = acc[newly] / n[newly][:, None]
        have |= newly
    up = np.kron(seed, np.ones((4, 4, 1)))[: img.shape[0], : img.shape[1]]
    out[hole] = up[hole]
    for _ in range(iters):
        avg = (np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1)) / 4
        out[hole] = avg[hole]
    return out


def add_grain(filled, orig, hole, body):
    """Add back high-frequency crayon texture, borrowed from a nearby pixel
    that wasn't painted out."""
    blur = np.array(Image.fromarray(orig.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(float)
    hp = orig - blur
    h, w = hole.shape
    offsets = [(0, -15), (0, 15), (15, 0), (-15, 0), (12, 12), (-12, 12), (12, -12), (-12, -12), (0, -24), (0, 24)]
    out = filled.copy()
    for y, x in zip(*np.nonzero(hole)):
        for dy, dx in offsets:
            yy, xx = y + dy, x + dx
            if 0 <= yy < h and 0 <= xx < w and body[yy, xx] and not hole[yy, xx]:
                out[y, x] += 0.8 * hp[yy, xx]
                break
    return out


def main():
    im = Image.open(SRC).convert('RGBA')
    rgba = np.array(im).astype(float)
    hole = masks(rgba)
    body = rgba[..., 3] > 250
    hole &= body  # never touch the outline/edge pixels
    rgb = rgba[..., :3]
    # Lines next to the hole would bleed dark into the fill; treat them as
    # unknown too and keep only the light body colour as a source.
    lum = rgb @ np.array([0.3, 0.59, 0.11])
    src_hole = hole | (lum < 110) | ~body
    filled = diffuse(rgb, src_hole)
    filled = add_grain(filled, rgb, hole, body & (lum >= 110))
    result = rgb.copy()
    result[hole] = filled[hole]
    rgba[..., :3] = np.clip(result, 0, 255)
    fx, fy = face_coords(*hole.shape)
    x0, y0, x1, y1 = TRIM_BOX
    rgba[(fx >= x0) & (fx <= x1) & (fy >= y0) & (fy <= y1), 3] = 0
    flat = Image.fromarray(rgba.astype(np.uint8), 'RGBA')

    w, h = flat.size
    up = flat.convert('RGBa').resize((w * SCALE, h * SCALE), Image.LANCZOS).convert('RGBA')
    r, g, b, a = up.split()
    sharp = Image.merge('RGB', (r, g, b)).filter(ImageFilter.UnsharpMask(radius=1.6, percent=60, threshold=2))
    Image.merge('RGBA', (*sharp.split(), a)).save(OUT, optimize=True)
    print(f'wrote {OUT.name} ({w * SCALE}x{h * SCALE}), painted out {hole.sum()} px')


if __name__ == '__main__':
    main()
