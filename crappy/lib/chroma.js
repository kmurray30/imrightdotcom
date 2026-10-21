/**
 * Chroma keying for frames generated on a flat green background.
 *
 * Pure JS over RGBA Uint8Array buffers (no sharp) so it is cheap to unit test.
 *
 * Alpha is derived from the pixel's distance to the key color in the CbCr
 * plane. YCbCr is linear in RGB, so for a pixel that is a mix of foreground
 * and background the chroma distance is linear in the mix fraction, which
 * makes it a direct alpha estimate once normalised by a "solid foreground"
 * reference distance. Partially transparent pixels are then un-mixed so the
 * background colour is removed from the stored RGB, and any remaining green
 * cast is clamped (despill).
 */

export function rgbToCbCr(r, g, b) {
  const cb = -0.1687 * r - 0.3313 * g + 0.5 * b + 128;
  const cr = 0.5 * r - 0.4187 * g - 0.0813 * b + 128;
  return [cb, cr];
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median RGB of the four corner patches of a frame. Models never return the
 * exact #00FF00 they were asked for, so sample instead of assuming.
 * Throws when the sampled colour is not convincingly green.
 */
export function sampleKeyColor(rgba, width, height, patch = 16) {
  const p = Math.max(1, Math.min(patch, Math.floor(width / 2), Math.floor(height / 2)));
  const rs = [];
  const gs = [];
  const bs = [];
  const corners = [
    [0, 0],
    [width - p, 0],
    [0, height - p],
    [width - p, height - p],
  ];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + p; y++) {
      for (let x = cx; x < cx + p; x++) {
        const i = (y * width + x) * 4;
        rs.push(rgba[i]);
        gs.push(rgba[i + 1]);
        bs.push(rgba[i + 2]);
      }
    }
  }
  const key = [Math.round(median(rs)), Math.round(median(gs)), Math.round(median(bs))];
  assertGreen(key);
  return key;
}

export function assertGreen([r, g, b]) {
  if (g < 150 || g - Math.max(r, b) < 60) {
    throw new Error(
      `frame background is not green (sampled rgb(${r}, ${g}, ${b})) — the model ignored the background prompt`
    );
  }
}

/** Per-pixel chroma distance to the key colour as a Float32Array. */
export function chromaDistances(rgba, width, height, key) {
  const n = width * height;
  const [kcb, kcr] = rgbToCbCr(key[0], key[1], key[2]);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const [cb, cr] = rgbToCbCr(rgba[o], rgba[o + 1], rgba[o + 2]);
    d[i] = Math.hypot(cb - kcb, cr - kcr);
  }
  return d;
}

/**
 * Reference distance for "solid foreground": the median distance among
 * pixels clearly away from the key. Computed with a histogram so a 1080²
 * frame stays O(n).
 */
export function estimateReferenceDistance(distances, floor = 15) {
  let max = 0;
  for (let i = 0; i < distances.length; i++) if (distances[i] > max) max = distances[i];
  if (max <= floor) return floor + 1;
  const bins = 1024;
  const hist = new Uint32Array(bins);
  const cutoff = 0.6 * max;
  let count = 0;
  for (let i = 0; i < distances.length; i++) {
    const v = distances[i];
    if (v <= cutoff) continue;
    const bin = Math.min(bins - 1, Math.floor((v / max) * (bins - 1)));
    hist[bin]++;
    count++;
  }
  if (count === 0) return Math.max(floor + 1, max);
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc * 2 >= count) return Math.max(floor + 1, ((b + 0.5) / (bins - 1)) * max);
  }
  return Math.max(floor + 1, max);
}

/**
 * Chroma distance a fully opaque neutral (grey/white/black) pixel has from
 * the key. Neutral colours sit at the CbCr origin, so this is the smallest
 * distance any plausible non-green foreground colour can have; anything at
 * or beyond it is treated as solid.
 */
export function neutralDistance(key) {
  const [kcb, kcr] = rgbToCbCr(key[0], key[1], key[2]);
  return Math.hypot(128 - kcb, 128 - kcr);
}

/**
 * Distance at which a pixel counts as fully opaque: a little under the
 * smaller of the neutral distance and the measured solid-foreground median,
 * so flat-shaded highlights and eyes never end up semi-transparent.
 */
export function solidDistance(distances, key, floor = 15) {
  const ref = Math.min(neutralDistance(key), estimateReferenceDistance(distances, floor));
  return Math.max(floor + 1, ref * 0.95);
}

/** Linear ramp: chroma distance is linear in the fg/bg mix, so alpha is too. */
function ramp(edge0, edge1, x) {
  return Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
}

function erodeAlpha(rgba, width, height, iterations) {
  let src = rgba;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(src);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let min = 255;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) {
            min = 0;
            continue;
          }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) {
              min = 0;
              continue;
            }
            const a = src[(yy * width + xx) * 4 + 3];
            if (a < min) min = a;
          }
        }
        out[(y * width + x) * 4 + 3] = min;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Key one RGBA frame. Returns a new RGBA Uint8Array with alpha set, the
 * background colour un-mixed out of soft edges, green spill clamped, and
 * fully transparent pixels zeroed.
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} key sampled background colour
 * @param {{ floor?: number, dSolid?: number, erode?: number }} [opts]
 *   dSolid: pass the value measured on frame 0 to key a whole take consistently
 * @returns {{ data: Uint8Array, dSolid: number }}
 */
export function keyFrame(rgba, width, height, key, opts = {}) {
  const floor = opts.floor ?? 15;
  const distances = chromaDistances(rgba, width, height, key);
  const dSolid = opts.dSolid ?? solidDistance(distances, key, floor);
  const out = new Uint8Array(rgba.length);
  const [kr, kg, kb] = key;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const alpha = ramp(floor, dSolid, distances[i]);
    if (alpha <= 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    let r = rgba[o];
    let g = rgba[o + 1];
    let b = rgba[o + 2];
    if (alpha < 1) {
      const inv = 1 - alpha;
      r = (r - inv * kr) / alpha;
      g = (g - inv * kg) / alpha;
      b = (b - inv * kb) / alpha;
    }
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    // Despill: the character is brown/white/black, none of which has green
    // above both red and blue, so clamping green only touches spill.
    const spillCap = Math.max(r, b) + 10;
    if (g > spillCap) g = spillCap;
    out[o] = Math.round(r);
    out[o + 1] = Math.round(g);
    out[o + 2] = Math.round(b);
    out[o + 3] = Math.round(alpha * 255);
  }
  const data = opts.erode > 0 ? erodeAlpha(out, width, height, opts.erode) : out;
  return { data, dSolid };
}
