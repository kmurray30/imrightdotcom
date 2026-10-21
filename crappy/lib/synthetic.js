/**
 * Synthetic green-screen hubs and takes built from the placeholder
 * character, so the real extraction path (ffmpeg → key → trim → resample →
 * align → pack) can be exercised without spending on fal.ai. Used by the
 * integration test and by `crappy synthetic --out <dir>`.
 *
 * A take mimics what we ask the video model for: a short static hold, one
 * slow continuous action, another hold; the slither additionally drifts
 * right so root-motion extraction has something to remove.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { CLIP_ORDER, HUB_NAMES } from './config.js';
import { renderPlaceholderFrame, renderPlaceholderHub } from './placeholder.js';

const run = promisify(execFile);

export const SYNTHETIC_DEFAULTS = Object.freeze({
  canvas: 720,
  slowFrames: 96,
  pad: 12,
  drift: 0.8,
  fps: 24,
});

const GREEN = { r: 0, g: 255, b: 0, alpha: 1 };

async function onGreen(frame, canvas, dx = 0) {
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: GREEN } })
    .composite([
      {
        input: Buffer.from(frame.data),
        raw: { width: frame.width, height: frame.height, channels: 4 },
        left: Math.round((canvas - frame.width) / 2 + dx),
        top: Math.round((canvas - frame.height) / 2),
      },
    ])
    .flatten({ background: GREEN })
    .png()
    .toBuffer();
}

export async function writeSyntheticHubs(hubsDir, box, opts = {}) {
  const o = { ...SYNTHETIC_DEFAULTS, ...opts };
  fs.mkdirSync(hubsDir, { recursive: true });
  const files = {};
  for (const hub of HUB_NAMES) {
    const frame = await renderPlaceholderHub(hub, o.slowFrames, box);
    files[hub] = path.join(hubsDir, `${hub}.green.png`);
    fs.writeFileSync(files[hub], await onGreen(frame, o.canvas));
  }
  return files;
}

export async function writeSyntheticTake(clip, takesDir, box, opts = {}) {
  const o = { ...SYNTHETIC_DEFAULTS, ...opts };
  const dir = path.join(takesDir, `${clip}-20260101-000000-t1-synthetic`);
  const src = path.join(dir, 'src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  let n = 0;
  const write = (png) => fs.writeFileSync(path.join(src, `${String(++n).padStart(4, '0')}.png`), png);
  const driftAt = (i) => (clip === 'slither' ? i * o.drift : 0);

  const first = await renderPlaceholderFrame(clip, 0, o.slowFrames, box);
  for (let i = 0; i < o.pad; i++) write(await onGreen(first, o.canvas));
  for (let i = 0; i < o.slowFrames; i++) {
    write(await onGreen(await renderPlaceholderFrame(clip, i, o.slowFrames, box), o.canvas, driftAt(i)));
  }
  const last = await renderPlaceholderFrame(clip, o.slowFrames - 1, o.slowFrames, box);
  for (let i = 0; i < o.pad; i++) write(await onGreen(last, o.canvas, driftAt(o.slowFrames - 1)));

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    String(o.fps),
    '-i',
    path.join(src, '%04d.png'),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    path.join(dir, 'take.mp4'),
  ]);
  fs.rmSync(src, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(dir, 'request.json'),
    JSON.stringify({ clip, modelKey: 'synthetic', model: 'synthetic placeholder render', prompt: null }, null, 2)
  );
  return dir;
}

/** Hubs + one take per clip under rootDir/{hubs,takes}. */
export async function writeSyntheticSet(rootDir, box, opts = {}) {
  const hubsDir = path.join(rootDir, 'hubs');
  const takesDir = path.join(rootDir, 'takes');
  await writeSyntheticHubs(hubsDir, box, opts);
  for (const clip of CLIP_ORDER) {
    await writeSyntheticTake(clip, takesDir, box, opts);
    opts.log?.(`synthetic take written for ${clip}`);
  }
  return { hubsDir, takesDir };
}
