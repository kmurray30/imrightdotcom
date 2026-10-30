import { describe, test } from 'node:test';
import assert from 'node:assert';
import { HALF_TO_FLOAT, decodeHalfInto, normalizedPrefix, kmeans, trainPq, centroidNorms, encode, buildLut, adcScore, decode, TopK, rng } from '../pq.js';
import { encodeHalfvec } from '../vectorCopy.js';

describe('half-precision decoding', () => {
  test('reads pgvector halfvec bytes back to the values written', () => {
    const values = [0, 1, -1, 0.5, 0.0999755859375, -0.2734375, 65504];
    const bytes = encodeHalfvec(values); // 4-byte header, then big-endian float16s
    const out = new Float32Array(values.length);
    decodeHalfInto(bytes, 4, values.length, out, 0);
    assert.deepStrictEqual(Array.from(out), values);
    assert.strictEqual(HALF_TO_FLOAT[0x3c00], 1);
  });
});

describe('normalizedPrefix', () => {
  test('scales the first dims to unit length', () => {
    const out = new Float32Array(2);
    normalizedPrefix(new Float32Array([3, 4, 100]), 0, 2, out);
    assert.deepStrictEqual(Array.from(out).map((v) => +v.toFixed(6)), [0.6, 0.8]);
  });
});

describe('kmeans', () => {
  test('finds well-separated clusters', () => {
    const points = [];
    for (const [x, y] of [[0, 0], [10, 10], [-10, 10]]) for (let i = 0; i < 50; i++) points.push(x + (i % 5) * 0.01, y - (i % 7) * 0.01);
    const centroids = kmeans(new Float32Array(points), 150, 2, 0, 2, 3, { iterations: 10, seed: 3 });
    const found = [0, 1, 2].map((c) => [Math.round(centroids[2 * c]) || 0, Math.round(centroids[2 * c + 1]) || 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepStrictEqual(found, [[-10, 10], [0, 0], [10, 10]]);
  });
});

describe('PQ', () => {
  const dims = 16;
  const n = 2000;
  const random = rng(11);
  const sample = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    const v = Array.from({ length: dims }, () => random() * 2 - 1);
    normalizedPrefix(new Float32Array(v), 0, dims, sample, i * dims);
  }

  test('the lookup-table score equals the dot product with the decoded vector', () => {
    const m = 4;
    const codebooks = trainPq(sample, n, dims, m, { iterations: 5 });
    const norms = centroidNorms(codebooks, dims, m);
    const codes = new Uint8Array(m);
    encode(sample, 0, codebooks, norms, dims, m, codes);
    const query = sample.subarray(dims, 2 * dims);
    const decoded = decode(codes, 0, codebooks, dims, m);
    const exact = decoded.reduce((sum, v, j) => sum + v * query[j], 0);
    assert.ok(Math.abs(adcScore(buildLut(query, codebooks, dims, m), codes, 0, m) - exact) < 1e-5);
  });

  test('more bytes per vector approximate the true dot product better', () => {
    const errorFor = (m) => {
      const codebooks = trainPq(sample, n, dims, m, { iterations: 8 });
      const norms = centroidNorms(codebooks, dims, m);
      const query = sample.subarray(0, dims);
      const lut = buildLut(query, codebooks, dims, m);
      const codes = new Uint8Array(m);
      let error = 0;
      for (let i = 1; i < 300; i++) {
        encode(sample, i * dims, codebooks, norms, dims, m, codes);
        let exact = 0;
        for (let j = 0; j < dims; j++) exact += sample[i * dims + j] * query[j];
        error += Math.abs(adcScore(lut, codes, 0, m) - exact);
      }
      return error;
    };
    assert.ok(errorFor(8) < errorFor(2));
  });

  test('encode picks the nearest centroid in each subspace', () => {
    const m = 2;
    const codebooks = trainPq(sample, n, dims, m, { iterations: 3 });
    const norms = centroidNorms(codebooks, dims, m);
    const codes = new Uint8Array(m);
    encode(sample, 5 * dims, codebooks, norms, dims, m, codes);
    const sub = dims / m;
    for (let s = 0; s < m; s++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < 256; c++) {
        let distance = 0;
        for (let j = 0; j < sub; j++) distance += (sample[5 * dims + s * sub + j] - codebooks[(s * 256 + c) * sub + j]) ** 2;
        if (distance < bestDistance) [best, bestDistance] = [c, distance];
      }
      assert.strictEqual(codes[s], best);
    }
  });
});

describe('TopK', () => {
  test('keeps the k highest scores, best first, with their ids and extras', () => {
    const top = new TopK(3);
    [[0.1, 1], [0.9, 2], [0.5, 3], [0.7, 4], [0.2, 5], [0.95, 6]].forEach(([s, id]) => top.push(s, id, id * 10));
    assert.deepStrictEqual(top.sorted(), [{ score: 0.95, id: 6, extra: 60 }, { score: 0.9, id: 2, extra: 20 }, { score: 0.7, id: 4, extra: 40 }]);
    assert.strictEqual(top.floor, 0.7);
  });
});
