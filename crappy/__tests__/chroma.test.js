/**
 * Run: node --test crappy/__tests__/chroma.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  assertGreen,
  chromaDistances,
  estimateReferenceDistance,
  keyFrame,
  neutralDistance,
  sampleKeyColor,
  solidDistance,
} from '../lib/chroma.js';
import { BROWN, GREEN, WHITE, fillRect, makeFrame, mix, pixelAt } from './helpers.js';

function brownSquareOnGreen() {
  const frame = makeFrame(64, 64, GREEN);
  // 1-px half-mixed border around a solid brown square, like an encoder edge.
  fillRect(frame, 19, 19, 26, 26, mix(BROWN, GREEN));
  fillRect(frame, 20, 20, 24, 24, BROWN);
  fillRect(frame, 28, 28, 2, 2, WHITE); // an eye highlight
  return frame;
}

describe('sampleKeyColor', () => {
  test('returns the corner colour even when it is off-green', () => {
    const frame = makeFrame(64, 64, [8, 241, 22, 255]);
    assert.deepStrictEqual(sampleKeyColor(frame.data, 64, 64), [8, 241, 22]);
  });

  test('ignores the character when it does not touch the corners', () => {
    const frame = brownSquareOnGreen();
    assert.deepStrictEqual(sampleKeyColor(frame.data, 64, 64), [0, 255, 0]);
  });

  test('throws when the background is not green', () => {
    const frame = makeFrame(64, 64, [200, 200, 200, 255]);
    assert.throws(() => sampleKeyColor(frame.data, 64, 64), /not green/);
    assert.throws(() => assertGreen([120, 160, 130]), /not green/);
  });
});

describe('keyFrame', () => {
  const frame = brownSquareOnGreen();
  const key = [0, 255, 0];
  const { data, dSolid } = keyFrame(frame.data, 64, 64, key, { floor: 15 });
  const keyed = { data, width: 64, height: 64 };

  test('solid distance sits just under the neutral/brown distance', () => {
    const d = chromaDistances(frame.data, 64, 64, key);
    const ref = estimateReferenceDistance(d, 15);
    assert.ok(ref > 100 && ref < 200, `median ref ${ref}`);
    const neutral = neutralDistance(key);
    assert.ok(Math.abs(neutral - 136) < 2, `neutral ${neutral}`);
    assert.ok(Math.abs(solidDistance(d, key, 15) - dSolid) < 1e-9);
    assert.ok(dSolid < neutral && dSolid > 0.9 * neutral, `dSolid ${dSolid}`);
  });

  test('background becomes fully transparent and zeroed', () => {
    assert.deepStrictEqual(pixelAt(keyed, 2, 2), [0, 0, 0, 0]);
    assert.deepStrictEqual(pixelAt(keyed, 60, 10), [0, 0, 0, 0]);
  });

  test('solid interior keeps its colour at full alpha', () => {
    const [r, g, b, a] = pixelAt(keyed, 30, 22);
    assert.strictEqual(a, 255);
    assert.ok(Math.abs(r - BROWN[0]) <= 1 && Math.abs(g - BROWN[1]) <= 1 && Math.abs(b - BROWN[2]) <= 1);
  });

  test('white pixels survive despill untouched', () => {
    assert.deepStrictEqual(pixelAt(keyed, 28, 28), [255, 255, 255, 255]);
  });

  test('half-mixed edge gets ~half alpha and is un-mixed back towards brown', () => {
    const [r, g, b, a] = pixelAt(keyed, 19, 30);
    assert.ok(Math.abs(a - 128) <= 25, `alpha ${a}`);
    assert.ok(Math.abs(r - BROWN[0]) <= 12, `r ${r}`);
    assert.ok(Math.abs(g - BROWN[1]) <= 12, `g ${g}`);
    assert.ok(Math.abs(b - BROWN[2]) <= 12, `b ${b}`);
  });

  test('erode shrinks the alpha mask by one pixel per iteration', () => {
    const eroded = keyFrame(frame.data, 64, 64, key, { floor: 15, erode: 1 }).data;
    const k = { data: eroded, width: 64, height: 64 };
    assert.strictEqual(pixelAt(k, 19, 30)[3], 0); // former soft edge gone
    assert.strictEqual(pixelAt(k, 21, 30)[3], 255); // interior intact
  });
});
