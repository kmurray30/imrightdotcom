/**
 * Run: node --test crappy/__tests__/pack.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import { packSheet, sheetLayout } from '../lib/pack.js';
import { makeFrame } from './helpers.js';

describe('sheetLayout', () => {
  test('lays frames out row-major', () => {
    const layout = sheetLayout(5, 3, 4, 4);
    assert.strictEqual(layout.rows, 2);
    assert.strictEqual(layout.sheetWidth, 12);
    assert.strictEqual(layout.sheetHeight, 8);
    assert.deepStrictEqual(layout.cells[4], { left: 4, top: 4 });
  });
});

describe('packSheet', () => {
  const colours = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
    [0, 255, 255, 255],
  ];
  const frames = colours.map((c) => Buffer.from(makeFrame(4, 4, c).data));

  test('png: every frame lands in its cell and unused cells stay transparent', async () => {
    const sheet = await packSheet(frames, { frameWidth: 4, frameHeight: 4, columns: 3, palette: false });
    assert.strictEqual(sheet.sheetWidth, 12);
    assert.strictEqual(sheet.sheetHeight, 8);
    assert.strictEqual(sheet.rows, 2);
    const { data, info } = await sharp(sheet.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.strictEqual(info.width, 12);
    const px = (x, y) => Array.from(data.slice((y * 12 + x) * 4, (y * 12 + x) * 4 + 4));
    assert.deepStrictEqual(px(0, 0), colours[0]);
    assert.deepStrictEqual(px(4, 0), colours[1]);
    assert.deepStrictEqual(px(8, 0), colours[2]);
    assert.deepStrictEqual(px(0, 4), colours[3]);
    assert.deepStrictEqual(px(4, 4), colours[4]);
    assert.strictEqual(px(8, 4)[3], 0);
  });

  test('palette png and lossless webp both round-trip', async () => {
    const png = await packSheet(frames, { frameWidth: 4, frameHeight: 4, columns: 3, palette: true });
    const webp = await packSheet(frames, { frameWidth: 4, frameHeight: 4, columns: 3, format: 'webp' });
    assert.strictEqual(png.ext, 'png');
    assert.strictEqual(webp.ext, 'webp');
    for (const sheet of [png, webp]) {
      const { data } = await sharp(sheet.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.deepStrictEqual(Array.from(data.slice(0, 4)), colours[0]);
    }
  });

  test('rejects frames of the wrong size', async () => {
    await assert.rejects(
      () => packSheet([Buffer.alloc(10)], { frameWidth: 4, frameHeight: 4, columns: 3 }),
      /expected 64/
    );
  });
});
