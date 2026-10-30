/**
 * Product quantization (PQ) for the span vectors, used by
 * scripts/compare-quantization.js to measure how much search quality each
 * compression keeps. A vector of `dims` floats is cut into `m` equal
 * sub-vectors, and each sub-vector is replaced by the index (one byte) of
 * its nearest centroid in that subspace's codebook of 256: `m` bytes per
 * vector. A query is compared with a code through a lookup table of its dot
 * product with every centroid (asymmetric distance computation), so scoring
 * a span costs `m` table reads.
 */

const CENTROIDS = 256;

/** Float value of every half-precision bit pattern (pgvector halfvec stores binary float16). */
export const HALF_TO_FLOAT = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    if (exponent === 0) table[h] = sign * 2 ** -14 * (fraction / 1024);
    else if (exponent === 31) table[h] = fraction ? NaN : sign * Infinity;
    else table[h] = sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  return table;
})();

/**
 * Decodes `count` big-endian float16 values (pgvector's halfvec binary send
 * format, after its 4-byte header) from `bytes` at `offset` into `out` at `outOffset`.
 */
export function decodeHalfInto(bytes, offset, count, out, outOffset) {
  for (let i = 0; i < count; i++) {
    const p = offset + 2 * i;
    out[outOffset + i] = HALF_TO_FLOAT[(bytes[p] << 8) | bytes[p + 1]];
  }
}

/** Writes `vector[offset .. offset+dims)` scaled to unit length into `out` at `outOffset`. */
export function normalizedPrefix(vector, offset, dims, out, outOffset = 0) {
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vector[offset + i] * vector[offset + i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) out[outOffset + i] = vector[offset + i] / norm;
}

/** A small deterministic PRNG (mulberry32), so training is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lloyd's k-means on `n` points of `dim` floats (row-major in `data`, reading
 * columns [start, start+dim) of rows `stride` wide). Returns k × dim centroids.
 */
export function kmeans(data, n, stride, start, dim, k, { iterations = 15, seed = 1 } = {}) {
  const random = rng(seed);
  const centroids = new Float32Array(k * dim);
  // k-means++ starting points: each next one is a point drawn in proportion to
  // its squared distance from the nearest one so far, so clusters aren't left
  // uncovered by two starts landing in the same one.
  const nearest = new Float64Array(n).fill(Infinity);
  let row = Math.floor(random() * n);
  for (let c = 0; c < k; c++) {
    for (let j = 0; j < dim; j++) centroids[c * dim + j] = data[row * stride + start + j];
    let total = 0;
    for (let i = 0; i < n; i++) {
      let distance = 0;
      for (let j = 0; j < dim; j++) {
        const diff = data[i * stride + start + j] - centroids[c * dim + j];
        distance += diff * diff;
      }
      if (distance < nearest[i]) nearest[i] = distance;
      total += nearest[i];
    }
    let target = random() * total;
    row = n - 1;
    for (let i = 0; i < n; i++) {
      target -= nearest[i];
      if (target <= 0) {
        row = i;
        break;
      }
    }
  }
  const assignment = new Int32Array(n);
  const sums = new Float64Array(k * dim);
  const counts = new Int32Array(k);
  for (let iteration = 0; iteration < iterations; iteration++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const base = i * stride + start;
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        let distance = 0;
        const cb = c * dim;
        for (let j = 0; j < dim; j++) {
          const diff = data[base + j] - centroids[cb + j];
          distance += diff * diff;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      assignment[i] = best;
      counts[best]++;
      for (let j = 0; j < dim; j++) sums[best * dim + j] += data[base + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // An empty cluster restarts at a random point.
        const row = Math.floor(random() * n);
        for (let j = 0; j < dim; j++) centroids[c * dim + j] = data[row * stride + start + j];
        continue;
      }
      for (let j = 0; j < dim; j++) centroids[c * dim + j] = sums[c * dim + j] / counts[c];
    }
  }
  return centroids;
}

/**
 * Trains `m` codebooks of 256 centroids on `n` sample vectors of `dims`
 * floats. Returns m × 256 × (dims/m) floats.
 */
export function trainPq(sample, n, dims, m, options = {}) {
  const sub = dims / m;
  if (!Number.isInteger(sub)) throw new Error(`dims ${dims} is not divisible by m ${m}`);
  const codebooks = new Float32Array(m * CENTROIDS * sub);
  for (let s = 0; s < m; s++) {
    codebooks.set(kmeans(sample, n, dims, s * sub, sub, CENTROIDS, { ...options, seed: (options.seed ?? 1) + s }), s * CENTROIDS * sub);
  }
  return codebooks;
}

/** Squared norms of every centroid (m × 256), so encoding can skip a subtraction per dimension. */
export function centroidNorms(codebooks, dims, m) {
  const sub = dims / m;
  const norms = new Float32Array(m * CENTROIDS);
  for (let c = 0; c < m * CENTROIDS; c++) {
    let sum = 0;
    for (let j = 0; j < sub; j++) sum += codebooks[c * sub + j] ** 2;
    norms[c] = sum;
  }
  return norms;
}

/** PQ code (m bytes, into `codes` at `codesOffset`) of `vector[offset .. offset+dims)`. */
export function encode(vector, offset, codebooks, norms, dims, m, codes, codesOffset = 0) {
  const sub = dims / m;
  for (let s = 0; s < m; s++) {
    const vb = offset + s * sub;
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < CENTROIDS; c++) {
      const cb = (s * CENTROIDS + c) * sub;
      let dot = 0;
      for (let j = 0; j < sub; j++) dot += vector[vb + j] * codebooks[cb + j];
      const distance = norms[s * CENTROIDS + c] - 2 * dot; // |v - c|² minus the constant |v|²
      if (distance < bestDistance) {
        bestDistance = distance;
        best = c;
      }
    }
    codes[codesOffset + s] = best;
  }
}

/** Lookup table (m × 256) of the query's dot product with every centroid. */
export function buildLut(query, codebooks, dims, m) {
  const sub = dims / m;
  const lut = new Float32Array(m * CENTROIDS);
  for (let s = 0; s < m; s++) {
    for (let c = 0; c < CENTROIDS; c++) {
      let dot = 0;
      const cb = (s * CENTROIDS + c) * sub;
      for (let j = 0; j < sub; j++) dot += query[s * sub + j] * codebooks[cb + j];
      lut[s * CENTROIDS + c] = dot;
    }
  }
  return lut;
}

/** Approximate dot product of a query (via its lookup table) with a PQ code. */
export function adcScore(lut, codes, codesOffset, m) {
  let score = 0;
  for (let s = 0; s < m; s++) score += lut[s * CENTROIDS + codes[codesOffset + s]];
  return score;
}

/** The vector a PQ code stands for (for tests and checks). */
export function decode(codes, codesOffset, codebooks, dims, m) {
  const sub = dims / m;
  const out = new Float32Array(dims);
  for (let s = 0; s < m; s++) {
    const cb = (s * CENTROIDS + codes[codesOffset + s]) * sub;
    for (let j = 0; j < sub; j++) out[s * sub + j] = codebooks[cb + j];
  }
  return out;
}

/** The k highest-scoring items seen (a min-heap), each with an id and one extra number. */
export class TopK {
  constructor(k) {
    this.k = k;
    this.scores = new Float64Array(k);
    this.ids = new Float64Array(k);
    this.extras = new Float64Array(k);
    this.size = 0;
  }

  /** Lowest score kept, or -Infinity while not full: anything not above it can be skipped. */
  get floor() {
    return this.size < this.k ? -Infinity : this.scores[0];
  }

  push(score, id, extra = 0) {
    if (this.size < this.k) {
      let i = this.size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.scores[parent] <= score) break;
        this.#set(i, this.scores[parent], this.ids[parent], this.extras[parent]);
        i = parent;
      }
      this.#set(i, score, id, extra);
      return;
    }
    if (score <= this.scores[0]) return;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.scores[right] < this.scores[left] ? right : left;
      if (this.scores[child] >= score) break;
      this.#set(i, this.scores[child], this.ids[child], this.extras[child]);
      i = child;
    }
    this.#set(i, score, id, extra);
  }

  #set(i, score, id, extra) {
    this.scores[i] = score;
    this.ids[i] = id;
    this.extras[i] = extra;
  }

  /** Items, best first: [{ score, id, extra }]. */
  sorted() {
    const items = [];
    for (let i = 0; i < this.size; i++) items.push({ score: this.scores[i], id: this.ids[i], extra: this.extras[i] });
    return items.sort((a, b) => b.score - a.score);
  }

  /** Plain arrays, for passing between threads. */
  toJSON() {
    return this.sorted();
  }
}
