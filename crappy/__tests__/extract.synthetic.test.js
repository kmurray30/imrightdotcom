/**
 * End-to-end check of the real extraction path without fal.ai: the
 * placeholder character on a green canvas, encoded by ffmpeg as a
 * "slow-motion take" (static padding + slow action + drift), pushed through
 * extractAll, then the sheets and manifest are inspected.
 *
 * Run: node --test crappy/__tests__/extract.synthetic.test.js
 * Skips when ffmpeg is not installed.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { CLIP_ORDER, DEFAULTS } from '../lib/config.js';
import { extractAll } from '../lib/extract.js';
import { hasFfmpeg } from '../lib/ffmpeg.js';
import { alphaBbox } from '../lib/frames.js';
import { SYNTHETIC_DEFAULTS, writeSyntheticSet } from '../lib/synthetic.js';

const ffmpegAvailable = await hasFfmpeg();
const box = { ...DEFAULTS };
const PAD = SYNTHETIC_DEFAULTS.pad;

async function sheetFrame(sheetFile, entry, index) {
  const { data, info } = await sharp(sheetFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const left = (index % entry.columns) * entry.frameWidth;
  const top = Math.floor(index / entry.columns) * entry.frameHeight;
  const frame = new Uint8Array(entry.frameWidth * entry.frameHeight * 4);
  for (let y = 0; y < entry.frameHeight; y++) {
    const start = ((top + y) * info.width + left) * 4;
    frame.set(data.subarray(start, start + entry.frameWidth * 4), y * entry.frameWidth * 4);
  }
  return frame;
}

describe('synthetic take → extractAll', { skip: !ffmpegAvailable && 'ffmpeg not installed' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crappy-synthetic-'));
  const outDir = path.join(tmp, 'public');
  const logs = [];
  let result;

  before(async () => {
    const { hubsDir, takesDir } = await writeSyntheticSet(tmp, box);
    result = await extractAll({ box, outDir, hubsDir, takesDir, log: (m) => logs.push(m) });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writes a valid manifest, three sheets and two hub frames', () => {
    assert.strictEqual(result.manifest.source, 'fal');
    for (const clip of CLIP_ORDER) {
      const entry = result.manifest.clips[clip];
      assert.ok(fs.existsSync(path.join(outDir, entry.sheet)), entry.sheet);
      assert.strictEqual(entry.frameCount, box.frameCount);
      assert.strictEqual(entry.take.trim.mode, 'longest-run', `${clip} should trim the static padding`);
      // The eased start of the move is below the motion threshold for a few frames.
      assert.ok(entry.take.trim.start >= PAD - 3 && entry.take.trim.start <= PAD + 8, `${clip} trim start ${entry.take.trim.start}`);
      assert.strictEqual(entry.take.modelKey, 'synthetic');
    }
    assert.ok(fs.existsSync(path.join(outDir, 'hubs', 'curled.png')));
    assert.ok(fs.existsSync(path.join(outDir, 'hubs', 'snake.png')));
    assert.ok(logs.some((m) => m.startsWith('scale:')));
  });

  test('root motion is recorded for the drifting slither and removed from its frames', async () => {
    const slither = result.manifest.clips.slither;
    assert.ok(slither.travelPerCycle > 20, `travelPerCycle ${slither.travelPerCycle}`);
    assert.ok(Math.abs(result.manifest.clips.curl.travelPerCycle) < 4);
    const centres = [];
    for (const i of [2, 8, 14, 20]) {
      const frame = await sheetFrame(path.join(outDir, slither.sheet), slither, i);
      const bbox = alphaBbox(frame, slither.frameWidth, slither.frameHeight, 128);
      centres.push((bbox.x0 + bbox.x1) / 2);
    }
    const spread = Math.max(...centres) - Math.min(...centres);
    assert.ok(spread < 12, `frames should stay centred after root-motion removal, spread ${spread}px`);
  });

  test('hub forcing makes frame 0 of uncurl identical to the curled hub frame', async () => {
    const uncurl = result.manifest.clips.uncurl;
    const frame0 = await sheetFrame(path.join(outDir, uncurl.sheet), uncurl, 0);
    const { data: hub } = await sharp(path.join(outDir, 'hubs', 'curled.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Palette PNGs may store any RGB under alpha 0, so compare visible pixels only.
    let diff = 0;
    let counted = 0;
    for (let p = 0; p < hub.length; p += 4) {
      if (hub[p + 3] === 0 && frame0[p + 3] === 0) continue;
      for (let c = 0; c < 4; c++) diff += Math.abs(hub[p + c] - frame0[p + c]);
      counted += 4;
    }
    assert.ok(counted > 0);
    assert.ok(diff / counted < 1.5, `mean abs diff ${diff / counted} over visible pixels (palette quantisation only)`);
  });

  test('keyed frames have no green left and sit on the anchor row', async () => {
    const curl = result.manifest.clips.curl;
    const { data, info } = await sharp(path.join(outDir, curl.sheet)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let greenish = 0;
    let opaque = 0;
    let lowest = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      const a = data[i * 4 + 3];
      if (a < 128) continue;
      opaque++;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      if (g > r + 40 && g > b + 40) greenish++;
      const y = Math.floor(i / info.width) % curl.frameHeight;
      if (y > lowest) lowest = y;
    }
    assert.ok(opaque > 20_000, `opaque ${opaque}`);
    assert.ok(greenish / opaque < 0.002, `green spill fraction ${greenish / opaque}`);
    assert.ok(Math.abs(lowest - curl.anchor.y) <= 3, `lowest opaque row ${lowest} vs anchor ${curl.anchor.y}`);
  });

  test('head and tail match scores are low for a take that honours its hubs', () => {
    for (const clip of CLIP_ORDER) {
      const take = result.manifest.clips[clip].take;
      assert.ok(take.headScore != null && take.headScore < 0.08, `${clip} head ${take.headScore}`);
      assert.ok(take.tailScore != null && take.tailScore < 0.08, `${clip} tail ${take.tailScore}`);
    }
  });
});
