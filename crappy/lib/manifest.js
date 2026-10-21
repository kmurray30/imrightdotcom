/**
 * manifest.json: the one file the client reads to know which sheets exist
 * and how to play them.
 */
import fs from 'fs';
import path from 'path';
import { CLIP_ORDER, CLIPS, HUB_NAMES, REST_HUB, anchorFor } from './config.js';

export const MANIFEST_VERSION = 1;

/**
 * @param {object} args
 * @param {'placeholder'|'fal'} args.source
 * @param {object} args.box
 * @param {{ px: number, snakeHeightPx: number }} args.scale
 * @param {Record<string, { image: string, source: string }>} args.hubs
 * @param {Record<string, object>} args.clips per-clip entries (see buildClipEntry)
 * @param {string} [args.generatedAt]
 */
export function buildManifest({ source, box, scale, hubs, clips, generatedAt }) {
  return {
    version: MANIFEST_VERSION,
    generatedAt: generatedAt ?? new Date().toISOString(),
    source,
    frame: { width: box.frameWidth, height: box.frameHeight },
    anchor: anchorFor(box),
    fps: box.fps,
    scale: { px: round4(scale.px), snakeHeightPx: Math.round(scale.snakeHeightPx) },
    hubs,
    rest: { hub: REST_HUB },
    clips,
  };
}

/**
 * @param {string} name clip name from CLIPS
 * @param {object} args
 */
export function buildClipEntry(
  name,
  { sheet, sheetWidth, sheetHeight, rows, columns, box, trajectory, take = null, fps }
) {
  const def = CLIPS[name];
  if (!def) throw new Error(`unknown clip "${name}"`);
  const travelPerCycle =
    trajectory.length > 1 ? round2(trajectory[trajectory.length - 1].dx - trajectory[0].dx) : 0;
  return {
    sheet,
    sheetWidth,
    sheetHeight,
    frameWidth: box.frameWidth,
    frameHeight: box.frameHeight,
    columns,
    rows,
    frameCount: trajectory.length,
    fps: fps ?? box.fps,
    loop: def.loop,
    hubFirst: def.hubFirst,
    hubLast: def.hubLast,
    anchor: anchorFor(box),
    trajectory,
    travelPerCycle,
    take,
  };
}

function fail(field, message) {
  throw new Error(`manifest.${field}: ${message}`);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validateManifest(m) {
  if (!m || typeof m !== 'object') fail('', 'not an object');
  if (m.version !== MANIFEST_VERSION) fail('version', `expected ${MANIFEST_VERSION}`);
  if (typeof m.generatedAt !== 'string') fail('generatedAt', 'missing');
  if (!['placeholder', 'fal'].includes(m.source)) fail('source', `unexpected "${m.source}"`);
  if (!m.frame || !isNum(m.frame.width) || !isNum(m.frame.height)) fail('frame', 'width/height required');
  if (!m.anchor || !isNum(m.anchor.x) || !isNum(m.anchor.y)) fail('anchor', 'x/y required');
  if (!isNum(m.fps) || m.fps <= 0) fail('fps', 'must be positive');
  if (!m.hubs) fail('hubs', 'missing');
  for (const hub of HUB_NAMES) {
    if (!m.hubs[hub] || typeof m.hubs[hub].image !== 'string') fail(`hubs.${hub}.image`, 'missing');
  }
  if (!m.rest || !HUB_NAMES.includes(m.rest.hub)) fail('rest.hub', 'must be a hub name');
  if (!m.clips) fail('clips', 'missing');
  for (const name of CLIP_ORDER) {
    const c = m.clips[name];
    if (!c) fail(`clips.${name}`, 'missing');
    const f = `clips.${name}`;
    if (typeof c.sheet !== 'string') fail(`${f}.sheet`, 'missing');
    for (const k of ['sheetWidth', 'sheetHeight', 'frameWidth', 'frameHeight', 'columns', 'rows', 'frameCount', 'fps']) {
      if (!isNum(c[k]) || c[k] <= 0) fail(`${f}.${k}`, 'must be a positive number');
    }
    if (typeof c.loop !== 'boolean') fail(`${f}.loop`, 'must be boolean');
    if (!HUB_NAMES.includes(c.hubFirst)) fail(`${f}.hubFirst`, 'must be a hub name');
    if (!HUB_NAMES.includes(c.hubLast)) fail(`${f}.hubLast`, 'must be a hub name');
    if (!Array.isArray(c.trajectory)) fail(`${f}.trajectory`, 'must be an array');
    if (c.trajectory.length !== c.frameCount) {
      fail(`${f}.trajectory`, `length ${c.trajectory.length} !== frameCount ${c.frameCount}`);
    }
    if (c.columns * c.rows < c.frameCount) fail(`${f}.rows`, 'columns*rows < frameCount');
    if (c.sheetWidth !== c.columns * c.frameWidth) fail(`${f}.sheetWidth`, 'must equal columns*frameWidth');
    if (c.sheetHeight !== c.rows * c.frameHeight) fail(`${f}.sheetHeight`, 'must equal rows*frameHeight');
    if (!c.anchor || !isNum(c.anchor.x) || !isNum(c.anchor.y)) fail(`${f}.anchor`, 'x/y required');
    if (!isNum(c.travelPerCycle)) fail(`${f}.travelPerCycle`, 'must be a number');
  }
  return m;
}

export function manifestPath(dir) {
  return path.join(dir, 'manifest.json');
}

export function writeManifest(dir, manifest) {
  validateManifest(manifest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath(dir);
}

export function readManifest(dir) {
  return validateManifest(JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}
