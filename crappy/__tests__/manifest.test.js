/**
 * Run: node --test crappy/__tests__/manifest.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CLIP_ORDER, DEFAULTS } from '../lib/config.js';
import { buildClipEntry, buildManifest, readManifest, validateManifest, writeManifest } from '../lib/manifest.js';

const box = { ...DEFAULTS };

function fakeManifest() {
  const clips = {};
  for (const name of CLIP_ORDER) {
    const trajectory = Array.from({ length: box.frameCount }, (_, i) => ({ dx: i * 2, dy: 0 }));
    clips[name] = buildClipEntry(name, {
      sheet: `${name}.png`,
      sheetWidth: box.columns * box.frameWidth,
      sheetHeight: 4 * box.frameHeight,
      rows: 4,
      columns: box.columns,
      box,
      trajectory,
    });
  }
  return buildManifest({
    source: 'placeholder',
    box,
    scale: { px: 1, snakeHeightPx: 172 },
    hubs: {
      curled: { image: 'hubs/curled.png', source: 'placeholder' },
      snake: { image: 'hubs/snake.png', source: 'placeholder' },
    },
    clips,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('manifest', () => {
  test('a built manifest validates and carries the clip table', () => {
    const m = validateManifest(fakeManifest());
    assert.strictEqual(m.clips.slither.loop, true);
    assert.strictEqual(m.clips.uncurl.hubFirst, 'curled');
    assert.strictEqual(m.clips.curl.hubLast, 'curled');
    assert.strictEqual(m.clips.uncurl.travelPerCycle, 46);
    assert.deepStrictEqual(m.anchor, { x: 192, y: 360 });
    assert.strictEqual(m.rest.hub, 'curled');
  });

  test('validation names the offending field', () => {
    const missing = fakeManifest();
    delete missing.clips.curl;
    assert.throws(() => validateManifest(missing), /clips\.curl/);

    const badLength = fakeManifest();
    badLength.clips.slither.trajectory.pop();
    assert.throws(() => validateManifest(badLength), /clips\.slither\.trajectory/);

    const badWidth = fakeManifest();
    badWidth.clips.uncurl.sheetWidth += 1;
    assert.throws(() => validateManifest(badWidth), /clips\.uncurl\.sheetWidth/);

    const badHub = fakeManifest();
    badHub.hubs.snake = {};
    assert.throws(() => validateManifest(badHub), /hubs\.snake\.image/);
  });

  test('writeManifest / readManifest round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crappy-manifest-'));
    try {
      const file = writeManifest(dir, fakeManifest());
      assert.ok(fs.existsSync(file));
      const back = readManifest(dir);
      assert.strictEqual(back.generatedAt, '2026-01-01T00:00:00.000Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
