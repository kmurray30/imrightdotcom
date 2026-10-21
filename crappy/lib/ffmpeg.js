/**
 * Thin ffmpeg/ffprobe wrappers (array args, no shell). Only the offline
 * extraction step needs these; the production server never does.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

export function parseRate(rate) {
  const [a, b] = String(rate ?? '').split('/').map(Number);
  if (!Number.isFinite(a)) return null;
  return b ? a / b : a;
}

export async function probeVideo(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_entries',
    'stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration',
    '-of',
    'json',
    file,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${file}`);
  return {
    width: stream.width,
    height: stream.height,
    fps: parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate),
    frames: Number(stream.nb_read_frames) || null,
    duration: Number(stream.duration) || null,
  };
}

export function listFrameFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Decode every frame of a video to numbered PNGs. Reuses existing output unless forced. */
export async function extractFrames(file, outDir, { force = false } = {}) {
  const existing = listFrameFiles(outDir);
  if (existing.length > 0 && !force) return existing;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      file,
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgba',
      path.join(outDir, '%04d.png'),
    ],
    { maxBuffer: 1 << 24 }
  );
  const frames = listFrameFiles(outDir);
  if (frames.length === 0) throw new Error(`ffmpeg produced no frames from ${file}`);
  return frames;
}
