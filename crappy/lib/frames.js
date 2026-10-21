/**
 * Pure frame-sequence math: bounding boxes, anchors, motion energy, static
 * trimming, resampling and trajectory smoothing. No sharp, no I/O.
 */

/** Inclusive bounding box of pixels with alpha above threshold, or null. */
export function alphaBbox(rgba, width, height, threshold = 40) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
}

/** Bottom-center of a bbox: where the character "stands". */
export function anchorOf(bbox) {
  return { x: (bbox.x0 + bbox.x1) / 2, y: bbox.y1 };
}

/**
 * Box-filter downscale of an RGBA frame to `targetWidth`, premultiplying by
 * alpha so transparent pixels contribute nothing. Used for motion energy.
 */
export function downscalePremultiplied(rgba, width, height, targetWidth = 96) {
  const factor = width / targetWidth;
  const tw = targetWidth;
  const th = Math.max(1, Math.round(height / factor));
  const out = new Float32Array(tw * th * 4);
  const counts = new Uint32Array(tw * th);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(th - 1, Math.floor(y / factor));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(tw - 1, Math.floor(x / factor));
      const si = (y * width + x) * 4;
      const a = rgba[si + 3] / 255;
      const ti = (ty * tw + tx) * 4;
      out[ti] += rgba[si] * a;
      out[ti + 1] += rgba[si + 1] * a;
      out[ti + 2] += rgba[si + 2] * a;
      out[ti + 3] += rgba[si + 3];
      counts[ty * tw + tx]++;
    }
  }
  for (let i = 0; i < tw * th; i++) {
    const c = counts[i] || 1;
    out[i * 4] /= c;
    out[i * 4 + 1] /= c;
    out[i * 4 + 2] /= c;
    out[i * 4 + 3] /= c;
  }
  return { data: out, width: tw, height: th };
}

/** Mean absolute difference between consecutive small frames. E[0] = E[1]. */
export function motionEnergy(smallFrames) {
  const n = smallFrames.length;
  const energy = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = smallFrames[i - 1].data;
    const b = smallFrames[i].data;
    let sum = 0;
    for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
    energy[i] = sum / a.length;
  }
  if (n > 1) energy[0] = energy[1];
  return energy;
}

/** Centered moving average with edge clamping. */
export function smooth1d(values, window = 3) {
  const half = Math.floor(window / 2);
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      sum += values[j];
    }
    out[i] = sum / (2 * half + 1);
  }
  return out;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Find the span of frames where something actually moves. Takes the longest
 * contiguous run above an adaptive threshold (so a model that performs two
 * separate actions doesn't get both), padded by one frame each side.
 * Falls back to the full range when the run is shorter than half the
 * requested output length.
 *
 * @returns {{ start: number, end: number, threshold: number, mode: 'longest-run' | 'full' }}
 */
export function trimStatic(energy, { frameCount = 24, pad = 1, smoothWindow = 3 } = {}) {
  const n = energy.length;
  if (n === 0) throw new Error('trimStatic: no frames');
  if (n === 1) return { start: 0, end: 0, threshold: 0, mode: 'full' };
  const smoothed = smooth1d(energy, smoothWindow);
  const max = Math.max(...smoothed);
  // 5% of peak keeps the gentle start/end of an eased move; 3× the quiet
  // floor rides above encoder noise on a genuinely static hold.
  const threshold = Math.max(3 * percentile(smoothed, 0.1), 0.05 * max);
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const active = i < n && smoothed[i] > threshold;
    if (active && runStart < 0) runStart = i;
    if (!active && runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0 || bestLen < frameCount / 2) {
    return { start: 0, end: n - 1, threshold, mode: 'full' };
  }
  const start = Math.max(0, bestStart - pad);
  const end = Math.min(n - 1, bestStart + bestLen - 1 + pad);
  return { start, end, threshold, mode: 'longest-run' };
}

/** Evenly spaced integer indices from start to end inclusive, length n. */
export function resampleIndices(start, end, n) {
  if (n <= 0) return [];
  if (n === 1) return [start];
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = start + Math.round((k * (end - start)) / (n - 1));
  return out;
}

/** Fractional sample positions for blended resampling. */
export function resamplePositions(start, end, n) {
  if (n <= 0) return [];
  if (n === 1) return [start];
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = start + (k * (end - start)) / (n - 1);
  return out;
}

/**
 * Smooth a list of {x, y} anchors with a centered moving average, pinning
 * the first and last points so clip endpoints stay exact.
 */
export function smoothTrajectory(points, window = 5) {
  if (points.length === 0) return [];
  const xs = smooth1d(
    points.map((p) => p.x),
    window
  );
  const ys = smooth1d(
    points.map((p) => p.y),
    window
  );
  const out = points.map((_, i) => ({ x: xs[i], y: ys[i] }));
  out[0] = { x: points[0].x, y: points[0].y };
  out[out.length - 1] = { x: points[points.length - 1].x, y: points[points.length - 1].y };
  return out;
}

/** Anchor offsets relative to the first point, as manifest trajectory entries. */
export function toTrajectory(anchors) {
  if (anchors.length === 0) return [];
  const base = anchors[0];
  return anchors.map((a) => ({ dx: round2(a.x - base.x), dy: round2(a.y - base.y) }));
}

/** Linear blend of two RGBA frames (premultiplied-safe enough for neighbours). */
export function blendFrames(a, b, t) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i] * (1 - t) + b[i] * t);
  return out;
}

/** Mean absolute difference between two equally sized buffers. */
export function meanAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('meanAbsDiff: size mismatch');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return a.length ? sum / a.length : 0;
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}
