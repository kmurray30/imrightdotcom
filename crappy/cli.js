#!/usr/bin/env node
/**
 * Crappy sprite pipeline: fal.ai video → sprite sheets for the /crappy demo.
 *
 * Usage:
 *   npm run crappy -- <command> [options]      (or: node crappy/cli.js <command>)
 *
 * Commands:
 *   placeholder                   render procedural stand-in sheets into client/public/crappy (no network)
 *   schema [--model <key>]        print a fal endpoint's input field names (log only, never fails)
 *   hub snake [--n 4] [--ref <png>]
 *                                 generate snake-pose hub candidates via fal (paid); with --ref, an
 *                                 existing character image is the style reference (edit model)
 *   hub curled [--n 2]            generate curled-pose candidates from hubs/snake.green.png (paid)
 *   hub pick <snake|curled> <n>   promote hubs/candidates/<hub>-<n>.png to hubs/<hub>.green.png
 *   clips [--clip a,b] [--takes 3] [--model <key>]
 *                                 generate video takes with the hubs pinned as first/last frame (paid)
 *   extract [--take clip=<takeId>,...]
 *                                 newest take per clip → sheets + manifest (needs ffmpeg)
 *   synthetic --out <dir>         fake green-screen hubs + takes from the placeholder, extracted into
 *                                 <dir>/public — exercises the real extract path without fal (needs ffmpeg)
 *   all                           hub snake (1) → pick → hub curled (1) → pick → clips → extract
 *
 * Options:
 *   --yes                 confirm spending money (or CRAPPY_YES=1)
 *   --dry-run             print the request bodies instead of calling fal
 *   --allow-unverified    allow a video model whose field names were not verified against its schema
 *   --safe-words          drop the explicit poop reference from prompts
 *   --ref <png>           reference image "hub snake" is edited from (e.g. assets/bunky.png);
 *                         pair with --model flux-kontext | flux-kontext-max | flux-2-edit
 *   --skip-schema         don't fetch the OpenAPI schema before generating clips
 *   --rescale             on a partial extract, recompute the global scale instead of reusing it
 *   --out <dir>           write sheets + manifest somewhere other than client/public/crappy
 *   --frame 384x384  --frames 24  --fps 24  --columns 6  --format png|webp  --no-palette
 *   --blend  --erode 1  --key-floor 15  --cfg 0.5
 *
 * Needs FAL_KEY (env.local or shell env) for hub/clips/all. See crappy/README.md.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadEnv } from '../imright/load-env.js';
import {
  CANDIDATES_DIR,
  CLIPS,
  CLIP_ORDER,
  HUBS_DIR,
  HUB_NAMES,
  PROJECT_ROOT,
  TAKES_DIR,
  hubGreenPath,
  resolveBox,
} from './lib/config.js';
import { sampleKeyColor } from './lib/chroma.js';
import {
  downloadToFile,
  elideDataUris,
  fetchOpenApiSchema,
  fileToDataUri,
  getFalKey,
  submitAndWait,
  summarizeSchema,
} from './lib/fal-client.js';
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  getImageModel,
  getVideoModel,
} from './lib/models.js';
import { composeClipPrompt, composeHubPrompt, negativePrompt } from './lib/prompts.js';
import { hasFfmpeg } from './lib/ffmpeg.js';
import { extractAll, placeholderAll } from './lib/extract.js';
import { writeSyntheticSet } from './lib/synthetic.js';

loadEnv();

const log = (message) => console.log(`[crappy] ${message}`);
const rel = (file) => path.relative(PROJECT_ROOT, file);

function camel(flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (value === undefined) {
      if (key.startsWith('no-')) {
        flags[camel(key.slice(3))] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    flags[camel(key)] = value;
  }
  return { flags, positional };
}

function boxFromFlags(flags) {
  const overrides = {};
  if (typeof flags.frame === 'string') {
    const match = /^(\d+)x(\d+)$/.exec(flags.frame);
    if (!match) throw new Error(`--frame expects WxH, got "${flags.frame}"`);
    overrides.frameWidth = match[1];
    overrides.frameHeight = match[2];
  }
  if (flags.frames !== undefined) overrides.frameCount = flags.frames;
  for (const key of ['fps', 'columns', 'format', 'palette', 'blend', 'erode', 'keyFloor', 'takes']) {
    if (flags[key] !== undefined) overrides[key] = flags[key];
  }
  return resolveBox(overrides);
}

function parseList(value) {
  if (value === undefined || value === true) return null;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function confirmSpend(costUsd, flags) {
  if (flags.yes === true || process.env.CRAPPY_YES === '1') return;
  throw new Error(`refusing to spend ≈ $${costUsd.toFixed(2)} without --yes (or CRAPPY_YES=1)`);
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
}

async function saveAsPng(url, dest) {
  const tmp = `${dest}.download`;
  await downloadToFile(url, tmp, { log });
  await sharp(tmp).png().toFile(dest);
  fs.rmSync(tmp, { force: true });
}

function nextCandidateIndex(hub) {
  if (!fs.existsSync(CANDIDATES_DIR)) return 1;
  const used = fs
    .readdirSync(CANDIDATES_DIR)
    .map((name) => new RegExp(`^${hub}-(\\d+)\\.png$`).exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 1;
}

async function cmdSchema({ flags }) {
  const keys = parseList(flags.model) ?? [DEFAULT_VIDEO_MODEL];
  for (const key of keys) {
    const model = VIDEO_MODELS[key] ? getVideoModel(key) : getImageModel(key);
    await logSchema(model.id);
  }
}

async function logSchema(modelId) {
  try {
    const summary = summarizeSchema(await fetchOpenApiSchema(modelId));
    if (summary.length === 0) {
      log(`schema ${modelId}: no *Input schema found`);
      return;
    }
    for (const entry of summary) {
      log(`schema ${modelId} ${entry.name} (required: ${entry.required.join(', ') || 'none'})`);
      for (const field of entry.fields) log(`  - ${field}`);
    }
  } catch (error) {
    log(`schema ${modelId}: could not fetch (${error.message}) — continuing`);
  }
}

async function pickHub(hub, index) {
  if (!HUB_NAMES.includes(hub)) throw new Error(`hub pick expects <snake|curled> <n>`);
  const n = Number(index);
  if (!Number.isInteger(n)) throw new Error(`hub pick ${hub} expects a candidate number`);
  const source = path.join(CANDIDATES_DIR, `${hub}-${n}.png`);
  if (!fs.existsSync(source)) throw new Error(`no candidate ${rel(source)}`);
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  try {
    const key = sampleKeyColor(data, info.width, info.height);
    log(`candidate background rgb(${key.join(', ')}) keys fine`);
  } catch (error) {
    log(`WARNING: ${error.message}`);
  }
  fs.mkdirSync(HUBS_DIR, { recursive: true });
  fs.copyFileSync(source, hubGreenPath(hub));
  log(`picked ${rel(source)} → ${rel(hubGreenPath(hub))}`);
}

/**
 * Small/transparent reference art (assets/bunky.png is 98×90 RGBA) is upscaled
 * and flattened onto the same chroma green the hubs use, so the edit model sees
 * both the character style and the background it should produce.
 */
async function prepareReference(file) {
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  const dest = path.join(CANDIDATES_DIR, `reference-${path.basename(file, path.extname(file))}.png`);
  const size = 1024;
  const inner = Math.round(size * 0.6);
  const art = await sharp(file)
    .resize(inner, inner, { fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
    .composite([{ input: art, gravity: 'centre' }])
    .flatten({ background: { r: 0, g: 255, b: 0 } })
    .png()
    .toFile(dest);
  return dest;
}

async function generateHub(hub, flags) {
  const n = Number(flags.n ?? (hub === 'snake' ? 4 : 2));
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('--n must be 1..4');
  const safeWords = flags.safeWords === true;
  const ref = typeof flags.ref === 'string' ? path.resolve(flags.ref) : null;
  if (ref && hub !== 'snake') throw new Error('--ref only applies to "hub snake" (curled is always edited from the snake hub)');
  const prompt = composeHubPrompt(hub, { safeWords, withReference: Boolean(ref) });
  let model;
  let body;
  if (hub === 'snake' && ref) {
    if (!fs.existsSync(ref)) throw new Error(`reference image not found: ${ref}`);
    model = getImageModel(typeof flags.model === 'string' ? flags.model : DEFAULT_EDIT_MODEL);
    const prepared = await prepareReference(ref);
    log(`reference: ${rel(ref)} → ${rel(prepared)}`);
    body = model.buildBody({ prompt, n, images: [flags.dryRun ? `<data-uri of ${rel(prepared)}>` : fileToDataUri(prepared)] });
  } else if (hub === 'snake') {
    model = getImageModel(typeof flags.model === 'string' ? flags.model : DEFAULT_IMAGE_MODEL);
    body = model.buildBody({ prompt, n });
  } else {
    const snake = hubGreenPath('snake');
    if (!fs.existsSync(snake) && !flags.dryRun) {
      throw new Error(`hub curled needs ${rel(snake)} first (crappy hub snake, then hub pick snake <n>)`);
    }
    model = getImageModel(typeof flags.model === 'string' ? flags.model : DEFAULT_EDIT_MODEL);
    const reference = fs.existsSync(snake) ? fileToDataUri(snake) : '<missing hubs/snake.green.png>';
    body = model.buildBody({ prompt, n, images: [reference] });
  }
  log(`hub ${hub}: ${n} candidate(s) on ${model.id}`);
  log(`prompt: ${prompt}`);
  if (flags.dryRun) {
    console.log(JSON.stringify(elideDataUris(body), null, 2));
    return [];
  }
  getFalKey();
  confirmSpend(n * model.pricePerImageUsd, flags);
  const { result, requestId } = await submitAndWait(model.id, body, { log });
  const urls = model.parseResult(result);
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  const start = nextCandidateIndex(hub);
  const written = [];
  for (const [i, url] of urls.entries()) {
    const dest = path.join(CANDIDATES_DIR, `${hub}-${start + i}.png`);
    await saveAsPng(url, dest);
    fs.writeFileSync(
      `${dest}.json`,
      JSON.stringify({ hub, prompt, modelKey: model.key, model: model.id, requestId, url, reference: ref ? rel(ref) : undefined }, null, 2)
    );
    written.push(start + i);
    log(`wrote ${rel(dest)}`);
  }
  log(`look at them, then: npm run crappy -- hub pick ${hub} <n>`);
  return written;
}

async function cmdHub({ positional, flags }) {
  const [sub, arg] = positional;
  if (sub === 'pick') return pickHub(arg, positional[2]);
  if (!HUB_NAMES.includes(sub)) throw new Error('hub expects: hub snake | hub curled | hub pick <hub> <n>');
  await generateHub(sub, flags);
}

async function cmdClips({ flags, box }) {
  const clips = parseList(flags.clip) ?? CLIP_ORDER;
  for (const clip of clips) if (!CLIPS[clip]) throw new Error(`unknown clip "${clip}" (known: ${CLIP_ORDER.join(', ')})`);
  const takes = Number(flags.takes ?? box.takes);
  if (!Number.isInteger(takes) || takes < 1) throw new Error('--takes must be a positive integer');
  const model = getVideoModel(typeof flags.model === 'string' ? flags.model : DEFAULT_VIDEO_MODEL);
  if (!model.verified && flags.allowUnverified !== true) {
    throw new Error(
      `video model "${model.key}" has unverified field names; run "crappy schema --model ${model.key}", fix lib/models.js if needed, then pass --allow-unverified`
    );
  }
  const safeWords = flags.safeWords === true;
  const negative = negativePrompt();
  const cfgScale = flags.cfg !== undefined ? Number(flags.cfg) : undefined;
  const total = clips.length * takes;
  const cost = total * model.pricePerClipUsd;
  log(`${total} take(s) on ${model.id} ≈ $${cost.toFixed(2)} (${model.nominalSeconds}s clips, remapped to ${box.frameCount} frames)`);

  const hubUris = {};
  for (const hub of HUB_NAMES) {
    const file = hubGreenPath(hub);
    if (fs.existsSync(file)) hubUris[hub] = fileToDataUri(file);
    else if (flags.dryRun) hubUris[hub] = `<missing ${rel(file)}>`;
    else throw new Error(`missing ${rel(file)} — generate and pick both hubs first`);
  }

  if (!flags.dryRun) {
    getFalKey();
    confirmSpend(cost, flags);
    if (flags.skipSchema !== true) await logSchema(model.id);
  }

  for (const clip of clips) {
    const def = CLIPS[clip];
    const prompt = composeClipPrompt(clip, { safeWords });
    for (let t = 1; t <= takes; t++) {
      const body = model.buildBody({
        prompt,
        negativePrompt: negative,
        firstImage: hubUris[def.hubFirst],
        lastImage: hubUris[def.hubLast],
        cfgScale,
      });
      if (flags.dryRun) {
        log(`${clip} take ${t}/${takes} (dry run) → POST https://queue.fal.run/${model.id}`);
        console.log(JSON.stringify(elideDataUris(body), null, 2));
        continue;
      }
      const takeId = `${clip}-${stamp()}-t${t}-${model.key}`;
      const dir = path.join(TAKES_DIR, takeId);
      fs.mkdirSync(dir, { recursive: true });
      const meta = {
        clip,
        takeId,
        modelKey: model.key,
        model: model.id,
        prompt,
        negativePrompt: negative,
        hubFirst: def.hubFirst,
        hubLast: def.hubLast,
        body: elideDataUris(body),
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(meta, null, 2));
      log(`${clip} take ${t}/${takes} → ${takeId}`);
      const { result, requestId, elapsedMs } = await submitAndWait(model.id, body, { log });
      const parsed = model.parseResult(result);
      const download = await downloadToFile(parsed.videoUrl, path.join(dir, 'take.mp4'), { log });
      fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ ...meta, requestId }, null, 2));
      fs.writeFileSync(
        path.join(dir, 'response.json'),
        JSON.stringify({ requestId, elapsedMs, download, result }, null, 2)
      );
      log(`${clip} take ${t}/${takes} done in ${Math.round(elapsedMs / 1000)}s (${Math.round(download.bytes / 1024)} KB)`);
    }
  }
  if (!flags.dryRun) log(`next: npm run crappy -- extract`);
}

async function cmdExtract({ flags, box }) {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg/ffprobe not found on PATH (needed to decode takes)');
  const clips = parseList(flags.clip) ?? CLIP_ORDER;
  const takeOverrides = {};
  for (const pair of parseList(flags.take) ?? []) {
    const [clip, id] = pair.split('=');
    if (!CLIPS[clip] || !id) throw new Error(`--take expects clip=<takeId>, got "${pair}"`);
    takeOverrides[clip] = id;
  }
  await extractAll({ clips, takeOverrides, box, log, outDir: outDirFrom(flags), rescale: flags.rescale === true });
}

async function cmdPlaceholder({ flags, box }) {
  await placeholderAll({ box, log, outDir: outDirFrom(flags) });
}

function outDirFrom(flags) {
  return typeof flags.out === 'string' ? path.resolve(flags.out) : undefined;
}

async function cmdSynthetic({ flags, box }) {
  if (typeof flags.out !== 'string') {
    throw new Error('synthetic needs --out <dir>: it writes fake hubs and takes there, never into crappy/');
  }
  if (!(await hasFfmpeg())) throw new Error('ffmpeg/ffprobe not found on PATH');
  const root = path.resolve(flags.out);
  const { hubsDir, takesDir } = await writeSyntheticSet(root, box, { log });
  await extractAll({ box, log, outDir: path.join(root, 'public'), hubsDir, takesDir });
  log(`inspect ${path.join(takesDir, '<take>', 'debug', 'contact.png')} and ${path.join(root, 'public')}`);
}

async function cmdAll({ flags, box }) {
  if (flags.dryRun) throw new Error('all does not support --dry-run; run the steps individually');
  getFalKey();
  const n = Number(flags.n ?? 1);
  const snakeCandidates = await generateHub('snake', { ...flags, n });
  await pickHub('snake', snakeCandidates[0]);
  const curledCandidates = await generateHub('curled', { ...flags, n });
  await pickHub('curled', curledCandidates[0]);
  await cmdClips({ flags, box });
  await cmdExtract({ flags, box });
}

function usage() {
  const header = fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
  console.log(header.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || command === 'help' || flags.help) {
    usage();
    return;
  }
  const box = boxFromFlags(flags);
  const ctx = { flags, positional: rest, box };
  switch (command) {
    case 'placeholder':
      return cmdPlaceholder(ctx);
    case 'schema':
      return cmdSchema(ctx);
    case 'hub':
      return cmdHub(ctx);
    case 'clips':
      return cmdClips(ctx);
    case 'extract':
      return cmdExtract(ctx);
    case 'synthetic':
      return cmdSynthetic(ctx);
    case 'all':
      return cmdAll(ctx);
    default:
      throw new Error(`unknown command "${command}" (try: npm run crappy -- help)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
