/**
 * Run: node --test crappy/__tests__/frames.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  alphaBbox,
  anchorOf,
  downscalePremultiplied,
  motionEnergy,
  resampleIndices,
  resamplePositions,
  smoothTrajectory,
  toTrajectory,
  trimStatic,
} from '../lib/frames.js';
import { BROWN, fillRect, makeFrame } from './helpers.js';

describe('alphaBbox / anchorOf', () => {
  test('finds the opaque region and its bottom-center', () => {
    const frame = fillRect(makeFrame(50, 40), 10, 5, 20, 12, BROWN);
    const bbox = alphaBbox(frame.data, 50, 40);
    assert.deepStrictEqual(bbox, { x0: 10, y0: 5, x1: 29, y1: 16 });
    assert.deepStrictEqual(anchorOf(bbox), { x: 19.5, y: 16 });
  });

  test('returns null for an empty frame', () => {
    assert.strictEqual(alphaBbox(makeFrame(8, 8).data, 8, 8), null);
  });
});

describe('motionEnergy + trimStatic', () => {
  function movingSquareFrames() {
    // 40 frames; the square only moves during frames 10..25.
    const frames = [];
    for (let i = 0; i < 40; i++) {
      const x = i < 10 ? 10 : i <= 25 ? 10 + (i - 10) * 3 : 10 + 15 * 3;
      frames.push(fillRect(makeFrame(96, 48), x, 20, 12, 12, BROWN));
    }
    return frames;
  }

  test('energy is zero while static and positive while moving', () => {
    const small = movingSquareFrames().map((f) => downscalePremultiplied(f.data, f.width, f.height, 48));
    const energy = motionEnergy(small);
    assert.strictEqual(energy.length, 40);
    assert.strictEqual(energy[5], 0);
    assert.ok(energy[15] > 0);
    assert.strictEqual(energy[35], 0);
  });

  test('trimStatic picks the longest active run with one frame of padding', () => {
    const small = movingSquareFrames().map((f) => downscalePremultiplied(f.data, f.width, f.height, 48));
    const energy = motionEnergy(small);
    // Add a one-frame blip elsewhere that must not win.
    energy[34] = energy[15] * 2;
    const trim = trimStatic(energy, { frameCount: 24 });
    assert.strictEqual(trim.mode, 'longest-run');
    assert.ok(trim.start >= 8 && trim.start <= 10, `start ${trim.start}`);
    assert.ok(trim.end >= 25 && trim.end <= 27, `end ${trim.end}`);
  });

  test('falls back to the full range when the active run is too short', () => {
    const energy = new Array(40).fill(0);
    energy[20] = 10;
    energy[21] = 10;
    const trim = trimStatic(energy, { frameCount: 24 });
    assert.deepStrictEqual([trim.start, trim.end, trim.mode], [0, 39, 'full']);
  });
});

describe('resampleIndices', () => {
  test('spans start..end inclusive, monotonic, exact length', () => {
    const idx = resampleIndices(9, 26, 24);
    assert.strictEqual(idx.length, 24);
    assert.strictEqual(idx[0], 9);
    assert.strictEqual(idx[23], 26);
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] >= idx[i - 1]);
  });

  test('handles degenerate ranges', () => {
    assert.deepStrictEqual(resampleIndices(5, 5, 24), new Array(24).fill(5));
    assert.deepStrictEqual(resampleIndices(0, 100, 1), [0]);
    assert.deepStrictEqual(resampleIndices(0, 100, 0), []);
    const pos = resamplePositions(0, 10, 3);
    assert.deepStrictEqual(pos, [0, 5, 10]);
  });
});

describe('smoothTrajectory / toTrajectory', () => {
  test('keeps endpoints and length, smooths the middle', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 12, y: 5 },
      { x: 30, y: 0 },
      { x: 40, y: 0 },
    ];
    const out = smoothTrajectory(pts, 3);
    assert.strictEqual(out.length, 5);
    assert.deepStrictEqual(out[0], pts[0]);
    assert.deepStrictEqual(out[4], pts[4]);
    assert.ok(out[2].y < 5 && out[2].y > 0);
    const traj = toTrajectory(out);
    assert.deepStrictEqual(traj[0], { dx: 0, dy: 0 });
    assert.strictEqual(traj[4].dx, 40);
  });
});
