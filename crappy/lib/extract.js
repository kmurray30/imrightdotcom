/**
 * Orchestration: video takes → keyed, trimmed, resampled, hub-forced,
 * aligned frames → packed sheets + manifest in client/public/crappy.
 *
 * `placeholderAll` renders procedural frames through the same
 * align → pack → manifest path so the demo works before any take exists.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { CLIPS, CLIP_ORDER, HUBS_DIR, HUB_NAMES, PROJECT_ROOT, PUBLIC_DIR, TAKES_DIR, anchorFor } from './config.js';
import { chromaDistances, keyFrame, sampleKeyColor, solidDistance } from './chroma.js';
import { alignFrame, computeGlobalScale } from './align.js';
import {
  alphaBbox,
  anchorOf,
  blendFrames,
  downscalePremultiplied,
  meanAbsDiff,
  motionEnergy,
  resampleIndices,
  resamplePositions,
  smoothTrajectory,
  toTrajectory,
  trimStatic,
} from './frames.js';
import { packSheet } from './pack.js';
import { buildClipEntry, buildManifest, manifestPath, validateManifest, writeManifest } from './manifest.js';
import { extractFrames, probeVideo } from './ffmpeg.js';
import { renderPlaceholderFrame, renderPlaceholderHub } from './placeholder.js';

const noop = () => {};
const SMALL_WIDTH = 96;
/** Head/tail match scores above this get a warning (0 = identical, 1 = nothing alike). */
export const MATCH_WARN = 0.08;

function asBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export async function loadRaw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function loadSmall(file, width = SMALL_WIDTH) {
  const { data, info } = await sharp(file).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function shrinkRaw(frame, width = SMALL_WIDTH) {
  const { data, info } = await sharp(asBuffer(frame.data), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .resize({ width })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function writePng(raw, width, height, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(asBuffer(raw), { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
}

const premultiply = (small) => downscalePremultiplied(small.data, small.width, small.height, small.width);

/** Load and key one of the green-background hub images. */
export async function loadKeyedHub(name, box, hubsDir = HUBS_DIR) {
  const file = path.join(hubsDir, `${name}.green.png`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `missing hub image ${path.relative(PROJECT_ROOT, file)} — run "crappy hub ${name}" then "crappy hub pick ${name} <n>" first`
    );
  }
  const raw = await loadRaw(file);
  const key = sampleKeyColor(raw.data, raw.width, raw.height);
  const { data, dSolid } = keyFrame(raw.data, raw.width, raw.height, key, { floor: box.keyFloor, erode: box.erode });
  const bbox = alphaBbox(data, raw.width, raw.height, box.bboxAlpha);
  if (!bbox) throw new Error(`hub ${name}: nothing left after keying`);
  return { name, file, data, width: raw.width, height: raw.height, key, dSolid, bbox, anchor: anchorOf(bbox) };
}

export function listTakes(clip, takesDir = TAKES_DIR) {
  if (!fs.existsSync(takesDir)) return [];
  return fs
    .readdirSync(takesDir)
    .filter((dir) => dir.startsWith(`${clip}-`) && fs.existsSync(path.join(takesDir, dir, 'take.mp4')))
    .sort();
}

export function resolveTakeDir(clip, override, takesDir = TAKES_DIR) {
  if (override) {
    const dir = path.isAbsolute(override) ? override : path.join(takesDir, override);
    if (!fs.existsSync(path.join(dir, 'take.mp4'))) throw new Error(`take "${override}" has no take.mp4`);
    return dir;
  }
  const takes = listTakes(clip, takesDir);
  if (takes.length === 0) {
    throw new Error(`no takes for "${clip}" in ${path.relative(PROJECT_ROOT, takesDir)} — run "crappy clips --clip ${clip}" first`);
  }
  return path.join(takesDir, takes[takes.length - 1]);
}

async function loadKeyedAt(frameFiles, pos, key, keyOpts, blend) {
  const lo = Math.floor(pos);
  const hi = Math.min(frameFiles.length - 1, Math.ceil(pos));
  const a = await loadRaw(frameFiles[lo]);
  const keyedA = keyFrame(a.data, a.width, a.height, key, keyOpts).data;
  if (!blend || hi === lo) return { data: keyedA, width: a.width, height: a.height };
  const b = await loadRaw(frameFiles[hi]);
  const keyedB = keyFrame(b.data, b.width, b.height, key, keyOpts).data;
  return { data: blendFrames(keyedA, keyedB, pos - lo), width: a.width, height: a.height };
}

/**
 * Analyse one take: key colour, motion energy, trim, sample positions and
 * per-sample bboxes/anchors. Pixel data is not retained (frames are
 * re-read during alignment once the global scale is known).
 */
export async function analyzeTake({ clip, takeDir, box, log = noop }) {
  const def = CLIPS[clip];
  if (!def) throw new Error(`unknown clip "${clip}"`);
  const video = path.join(takeDir, 'take.mp4');
  const probe = await probeVideo(video);
  const frameFiles = await extractFrames(video, path.join(takeDir, 'frames'));
  log(`${clip}: ${path.basename(takeDir)} → ${frameFiles.length} frames, ${probe.width}x${probe.height} @ ${probe.fps?.toFixed(2)} fps`);

  const first = await loadRaw(frameFiles[0]);
  const key = sampleKeyColor(first.data, first.width, first.height);
  const dSolid = solidDistance(chromaDistances(first.data, first.width, first.height, key), key, box.keyFloor);
  const keyOpts = { floor: box.keyFloor, dSolid, erode: box.erode };

  const smalls = [];
  for (const file of frameFiles) {
    const small = await loadSmall(file);
    const keyed = keyFrame(small.data, small.width, small.height, key, keyOpts).data;
    smalls.push(premultiply({ data: keyed, width: small.width, height: small.height }));
  }
  const energy = motionEnergy(smalls);
  const trim = trimStatic(energy, { frameCount: box.frameCount });
  const N = box.frameCount;
  const positions = box.blend ? resamplePositions(trim.start, trim.end, N) : resampleIndices(trim.start, trim.end, N);
  log(`${clip}: motion in frames ${trim.start}..${trim.end} of ${frameFiles.length} (${trim.mode}); sampling ${N}`);

  const sampled = [];
  for (const pos of positions) {
    const keyed = await loadKeyedAt(frameFiles, pos, key, keyOpts, box.blend);
    const bbox = alphaBbox(keyed.data, keyed.width, keyed.height, box.bboxAlpha);
    if (!bbox) throw new Error(`${clip}: frame ${pos} is empty after keying — check the take's background`);
    sampled.push({ pos, bbox, anchor: anchorOf(bbox), width: keyed.width, height: keyed.height });
  }
  const smoothedAnchors = smoothTrajectory(
    sampled.map((s) => s.anchor),
    5
  );
  const trajectory = toTrajectory(smoothedAnchors);
  const snakeIndex = def.snakePose === 'first' ? 0 : N - 1;
  const videoSnakeHeight = sampled[snakeIndex].bbox.y1 - sampled[snakeIndex].bbox.y0 + 1;

  return {
    clip,
    takeDir,
    takeId: path.basename(takeDir),
    probe,
    key,
    dSolid,
    keyOpts,
    frameFiles,
    smalls,
    energy,
    trim,
    positions,
    sampled,
    smoothedAnchors,
    trajectory,
    videoSnakeHeight,
  };
}

/** 0..1 dissimilarity between a small keyed video frame and a hub; null if shapes differ. */
async function hubMatchScore(small, hub) {
  const hubSmall = premultiply(await shrinkRaw(hub, small.width));
  if (hubSmall.width !== small.width || hubSmall.height !== small.height) return null;
  return meanAbsDiff(small.data, hubSmall.data) / 255;
}

function checkerboard(width, height, cell = 16) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = light ? 235 : 200;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

async function writeDebug(analysis, sheet) {
  const dir = path.join(analysis.takeDir, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  await sharp(checkerboard(sheet.sheetWidth, sheet.sheetHeight), {
    raw: { width: sheet.sheetWidth, height: sheet.sheetHeight, channels: 4 },
  })
    .composite([{ input: sheet.buffer, left: 0, top: 0 }])
    .png()
    .toFile(path.join(dir, 'contact.png'));
  fs.writeFileSync(
    path.join(dir, 'energy.json'),
    JSON.stringify(
      {
        key: analysis.key,
        dSolid: analysis.dSolid,
        trim: analysis.trim,
        positions: analysis.positions,
        headScore: analysis.headScore,
        tailScore: analysis.tailScore,
        energy: analysis.energy.map((e) => Math.round(e * 1000) / 1000),
        trajectory: analysis.trajectory,
        bboxes: analysis.sampled.map((s) => ({ pos: s.pos, ...s.bbox })),
      },
      null,
      2
    )
  );
}

function readExistingManifest(dir) {
  try {
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')));
  } catch {
    return null;
  }
}

function takeMeta(analysis, model) {
  let request = {};
  try {
    request = JSON.parse(fs.readFileSync(path.join(analysis.takeDir, 'request.json'), 'utf8'));
  } catch {
    /* takes made outside the CLI have no request.json */
  }
  return {
    id: analysis.takeId,
    modelKey: request.modelKey ?? model ?? null,
    model: request.model ?? null,
    requestId: request.requestId ?? null,
    prompt: request.prompt ?? null,
    negativePrompt: request.negativePrompt ?? null,
    video: {
      width: analysis.probe.width,
      height: analysis.probe.height,
      fps: analysis.probe.fps,
      frames: analysis.frameFiles.length,
    },
    trim: { start: analysis.trim.start, end: analysis.trim.end, mode: analysis.trim.mode },
    sampledIndices: analysis.positions,
    keyColor: analysis.key,
    headScore: analysis.headScore,
    tailScore: analysis.tailScore,
  };
}

/**
 * Extract the given clips (default: all three) from their newest takes and
 * write sheets + manifest to `outDir`.
 */
export async function extractAll({
  clips = CLIP_ORDER,
  takeOverrides = {},
  box,
  log = noop,
  outDir = PUBLIC_DIR,
  hubsDir = HUBS_DIR,
  takesDir = TAKES_DIR,
  rescale = false,
}) {
  for (const clip of clips) if (!CLIPS[clip]) throw new Error(`unknown clip "${clip}"`);
  const N = box.frameCount;
  const W = box.frameWidth;
  const H = box.frameHeight;

  const hubs = {};
  for (const name of HUB_NAMES) {
    hubs[name] = await loadKeyedHub(name, box, hubsDir);
    log(`hub ${name}: ${hubs[name].width}x${hubs[name].height}, key rgb(${hubs[name].key.join(', ')})`);
  }

  const analyses = {};
  for (const clip of clips) {
    const takeDir = resolveTakeDir(clip, takeOverrides[clip], takesDir);
    const analysis = await analyzeTake({ clip, takeDir, box, log });
    const def = CLIPS[clip];
    analysis.headScore = await hubMatchScore(analysis.smalls[analysis.trim.start], hubs[def.hubFirst]);
    analysis.tailScore = await hubMatchScore(analysis.smalls[analysis.trim.end], hubs[def.hubLast]);
    for (const [label, score] of [
      ['head', analysis.headScore],
      ['tail', analysis.tailScore],
    ]) {
      if (score == null) log(`${clip}: ${label} match not comparable (aspect differs from hub)`);
      else if (score > MATCH_WARN) log(`WARNING ${clip}: ${label} frame differs from its hub (score ${score.toFixed(3)} > ${MATCH_WARN}); consider another take`);
      else log(`${clip}: ${label} match ${score.toFixed(3)}`);
    }
    analyses[clip] = analysis;
  }

  const existing = readExistingManifest(outDir);
  const scale = computeGlobalScale({
    hubs: { snake: hubs.snake, curled: hubs.curled },
    clips: Object.fromEntries(
      Object.entries(analyses).map(([name, a]) => [
        name,
        {
          frames: a.sampled.map((s, i) => ({ bbox: s.bbox, anchor: a.smoothedAnchors[i] })),
          videoSnakeHeight: a.videoSnakeHeight,
        },
      ])
    ),
    box,
  });
  if (clips.length < CLIP_ORDER.length && existing?.source === 'fal' && !rescale) {
    // Partial re-extract: keep the previous hub scale so sheets stay consistent.
    const previous = existing.scale.px;
    for (const name of Object.keys(scale.sClips)) scale.sClips[name] = previous * (scale.sClips[name] / scale.sHub);
    scale.sHub = previous;
    scale.snakeHeightPx = Math.round((hubs.snake.bbox.y1 - hubs.snake.bbox.y0 + 1) * previous);
    log(`scale: reusing previous hub scale ${previous} (pass --rescale to recompute)`);
  } else {
    log(`scale: hub ${scale.sHub.toFixed(4)} (${scale.limiting}-limited), snake height ${scale.snakeHeightPx}px`);
  }

  const hubAligned = {};
  const hubEntries = {};
  for (const name of HUB_NAMES) {
    hubAligned[name] = await alignFrame(hubs[name], hubs[name].anchor, scale.sHub, box);
    await writePng(hubAligned[name], W, H, path.join(outDir, 'hubs', `${name}.png`));
    hubEntries[name] = { image: `hubs/${name}.png`, source: path.relative(PROJECT_ROOT, hubs[name].file) };
  }

  const clipEntries = {};
  for (const clip of clips) {
    const a = analyses[clip];
    const def = CLIPS[clip];
    const frames = [];
    for (let k = 0; k < N; k++) {
      if (k === 0) frames.push(hubAligned[def.hubFirst]);
      else if (k === N - 1) frames.push(hubAligned[def.hubLast]);
      else {
        const keyed = await loadKeyedAt(a.frameFiles, a.positions[k], a.key, a.keyOpts, box.blend);
        frames.push(await alignFrame(keyed, a.smoothedAnchors[k], scale.sClips[clip], box));
      }
    }
    const sheet = await packSheet(frames, {
      frameWidth: W,
      frameHeight: H,
      columns: box.columns,
      format: box.format,
      palette: box.palette,
    });
    const sheetName = `${clip}.${sheet.ext}`;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, sheetName), sheet.buffer);
    await writeDebug(a, sheet);
    clipEntries[clip] = buildClipEntry(clip, {
      sheet: sheetName,
      sheetWidth: sheet.sheetWidth,
      sheetHeight: sheet.sheetHeight,
      rows: sheet.rows,
      columns: sheet.columns,
      box,
      trajectory: a.trajectory,
      take: takeMeta(a),
    });
    log(`${clip}: wrote ${sheetName} (${Math.round(sheet.buffer.length / 1024)} KB, travel/cycle ${clipEntries[clip].travelPerCycle}px)`);
  }
  for (const clip of CLIP_ORDER) {
    if (!clipEntries[clip] && existing?.clips?.[clip]) clipEntries[clip] = existing.clips[clip];
  }
  const missing = CLIP_ORDER.filter((clip) => !clipEntries[clip]);
  if (missing.length) {
    throw new Error(`manifest would be missing clips ${missing.join(', ')} — extract all clips together the first time`);
  }

  const manifest = buildManifest({
    source: 'fal',
    box,
    scale: { px: scale.sHub, snakeHeightPx: scale.snakeHeightPx },
    hubs: hubEntries,
    clips: clipEntries,
  });
  const file = writeManifest(outDir, manifest);
  log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
  return { manifest, file };
}

/** Procedural stand-in sheets through the same align → pack → manifest path. */
export async function placeholderAll({ box, log = noop, outDir = PUBLIC_DIR }) {
  const N = box.frameCount;
  const W = box.frameWidth;
  const H = box.frameHeight;
  const anchor = anchorFor(box);

  const hubAligned = {};
  const hubEntries = {};
  for (const name of HUB_NAMES) {
    const frame = await renderPlaceholderHub(name, N, box);
    hubAligned[name] = await alignFrame(frame, anchor, 1, box);
    await writePng(hubAligned[name], W, H, path.join(outDir, 'hubs', `${name}.png`));
    hubEntries[name] = { image: `hubs/${name}.png`, source: 'placeholder' };
  }
  const snakeBbox = alphaBbox(hubAligned.snake, W, H, box.bboxAlpha);

  const clipEntries = {};
  for (const clip of CLIP_ORDER) {
    const frames = [];
    for (let k = 0; k < N; k++) {
      const frame = await renderPlaceholderFrame(clip, k, N, box);
      frames.push(await alignFrame(frame, anchor, 1, box));
    }
    const sheet = await packSheet(frames, {
      frameWidth: W,
      frameHeight: H,
      columns: box.columns,
      format: box.format,
      palette: box.palette,
    });
    const sheetName = `${clip}.${sheet.ext}`;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, sheetName), sheet.buffer);
    clipEntries[clip] = buildClipEntry(clip, {
      sheet: sheetName,
      sheetWidth: sheet.sheetWidth,
      sheetHeight: sheet.sheetHeight,
      rows: sheet.rows,
      columns: sheet.columns,
      box,
      trajectory: Array.from({ length: N }, () => ({ dx: 0, dy: 0 })),
      take: null,
    });
    log(`${clip}: wrote ${sheetName} (${Math.round(sheet.buffer.length / 1024)} KB)`);
  }

  const manifest = buildManifest({
    source: 'placeholder',
    box,
    scale: { px: 1, snakeHeightPx: snakeBbox ? snakeBbox.y1 - snakeBbox.y0 + 1 : 0 },
    hubs: hubEntries,
    clips: clipEntries,
  });
  const file = writeManifest(outDir, manifest);
  log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
  return { manifest, file };
}
