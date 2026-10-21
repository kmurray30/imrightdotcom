/**
 * Shared paths and defaults for the Crappy sprite pipeline.
 *
 * Every stage (hub generation, clip generation, extraction, placeholder
 * rendering) reads its sizes and clip table from here so the manifest and
 * sprite sheets come out byte-compatible whichever path produced them.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CRAPPY_ROOT = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(CRAPPY_ROOT, '..');
export const PROMPTS_DIR = path.join(CRAPPY_ROOT, 'prompts');
export const HUBS_DIR = path.join(CRAPPY_ROOT, 'hubs');
export const CANDIDATES_DIR = path.join(HUBS_DIR, 'candidates');
export const TAKES_DIR = path.join(CRAPPY_ROOT, 'takes');
/** Where the client-served output goes. Vite serves client/public/* at / in
 * dev and copies it into client/dist/ at build, which Express serves in prod. */
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'client', 'public', 'crappy');
export const PUBLIC_URL_BASE = '/crappy';

/** Sprite box + sampling defaults. Overridable from the CLI. */
export const DEFAULTS = Object.freeze({
  frameWidth: 384,
  frameHeight: 384,
  frameCount: 24,
  fps: 24,
  columns: 6,
  /** Distance from the bottom edge of the frame box to the anchor row. */
  anchorBottomMargin: 24,
  /** Horizontal margin the character must keep from the box edges. */
  fitMarginX: 24,
  /** Headroom kept above the tallest frame. */
  fitMarginTop: 8,
  /** Target height of the stretched-out snake pose as a fraction of frameHeight. */
  snakeHeightRatio: 0.45,
  /** Chroma distance (YCbCr) below which a pixel is pure background. */
  keyFloor: 15,
  /** Alpha threshold for bounding boxes. */
  bboxAlpha: 40,
  erode: 0,
  blend: false,
  format: 'png',
  palette: true,
  takes: 3,
});

export const HUB_NAMES = Object.freeze(['curled', 'snake']);
export const REST_HUB = 'curled';

/** Clip table: which hub each clip starts and ends on. */
export const CLIPS = Object.freeze({
  uncurl: Object.freeze({ hubFirst: 'curled', hubLast: 'snake', loop: false, snakePose: 'last' }),
  slither: Object.freeze({ hubFirst: 'snake', hubLast: 'snake', loop: true, snakePose: 'first' }),
  curl: Object.freeze({ hubFirst: 'snake', hubLast: 'curled', loop: false, snakePose: 'first' }),
});
export const CLIP_ORDER = Object.freeze(['uncurl', 'slither', 'curl']);

export function hubGreenPath(name) {
  return path.join(HUBS_DIR, `${name}.green.png`);
}

/** Anchor point (bottom-center of the character's base) inside the frame box. */
export function anchorFor(box) {
  return { x: Math.round(box.frameWidth / 2), y: box.frameHeight - box.anchorBottomMargin };
}

/** Merge CLI overrides onto DEFAULTS, coercing numbers. */
export function resolveBox(overrides = {}) {
  const box = { ...DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (typeof DEFAULTS[key] === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`Invalid numeric option --${key}=${value}`);
      box[key] = n;
    } else if (typeof DEFAULTS[key] === 'boolean') {
      box[key] = value === true || value === 'true' || value === '1';
    } else {
      box[key] = value;
    }
  }
  if (box.frameCount < 2) throw new Error('frameCount must be at least 2');
  if (box.columns < 1) throw new Error('columns must be at least 1');
  return box;
}
