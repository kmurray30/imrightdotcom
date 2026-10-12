#!/usr/bin/env node
/**
 * Compares embedding speed across ONNX Runtime devices on THIS machine, to
 * pick a value for EMBED_DEVICE (see textEmbeddings.js). Uses the exact same
 * model/options as production (loadExtractor + embedWith), with a
 * configurable call shape (texts per call, calls in flight — see below).
 *
 * Also checks each device's vectors against CPU's (cosine similarity) — the
 * index already holds CPU-built vectors, so a device is only usable if its
 * output matches. Expect ~1.0; a GPU computing internally in fp16 can drift
 * slightly, which is fine for search as long as it stays above ~0.999.
 *
 * A device that fails to load is reported and skipped, not fatal — that's a
 * valid answer ("not available here").
 *
 * Usage: [GROUP_SIZE=n] [IN_FLIGHT=n] node wiki_searcher/scripts/benchmark-embed-device.js [device ...]
 *   devices default to: cpu coreml webgpu  (cpu is always run first, as the reference)
 *   GROUP_SIZE (texts per call, default 5) / IN_FLIGHT (concurrent calls, default 8)
 */
import { loadExtractor, embedWith } from '../textEmbeddings.js';

// Call shape, overridable to measure how throughput scales with batch size.
// The build now makes one call per article batch (~40 texts) per chunk, with
// EMBED_CONCURRENCY (4) chunks in parallel: GROUP_SIZE=40 IN_FLIGHT=4.
const GROUP_SIZE = Number(process.env.GROUP_SIZE) || 5;
const IN_FLIGHT = Number(process.env.IN_FLIGHT) || 8;
const GROUP_COUNT = Math.max(IN_FLIGHT, Math.round(300 / GROUP_SIZE)); // ~300 texts total regardless of shape, so texts/s compares across runs

const requested = process.argv.slice(2);
const devices = ['cpu', ...(requested.length > 0 ? requested : ['coreml', 'webgpu']).filter((d) => d !== 'cpu')];

// Deterministic, paragraph-shaped texts of varied length (padding to each
// group's longest text is part of what's being measured, like in production).
const SENTENCES = [
  'The committee published its findings after an eighteen-month investigation into the incident.',
  'Critics argued that the methodology overstated the effect, citing several independent replications.',
  'Construction began in the spring, though funding disputes delayed completion by nearly two years.',
  'He later testified that he had never been informed of the decision before it was announced.',
  'The species is found primarily in coastal wetlands, where it feeds on small crustaceans.',
  'According to contemporary newspaper accounts, the crowd numbered in the tens of thousands.',
];
const texts = Array.from({ length: GROUP_SIZE * GROUP_COUNT }, (_, i) => {
  const sentenceCount = 2 + (i % 9); // ~2-10 sentences
  const body = Array.from({ length: sentenceCount }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(' ');
  return `Article ${i % 37} — Section ${i % 5}: ${body}`;
});
const groups = Array.from({ length: GROUP_COUNT }, (_, g) => texts.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE));

async function runGroups(extractor) {
  const vectorsByGroup = new Array(groups.length);
  let callMsTotal = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < groups.length) {
      const g = cursor++;
      const callStart = performance.now();
      vectorsByGroup[g] = await embedWith(extractor, groups[g]);
      callMsTotal += performance.now() - callStart;
    }
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  return { elapsedMs: performance.now() - start, avgCallMs: callMsTotal / groups.length, vectors: vectorsByGroup.flat() };
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum; // vectors are unit-normalized, so this is cosine similarity
}

const rows = [];
let reference = null;

for (const device of devices) {
  process.stdout.write(`${device}: loading... `);
  let extractor;
  const loadStart = performance.now();
  try {
    extractor = await loadExtractor(device);
  } catch (error) {
    console.log(`unavailable — ${error.message}`);
    rows.push({ device, note: 'unavailable' });
    continue;
  }
  const loadMs = performance.now() - loadStart;

  // First call includes one-time graph compilation on some backends (notably
  // CoreML) — reported separately so it doesn't skew the steady-state number.
  const firstStart = performance.now();
  await embedWith(extractor, groups[0]);
  const firstCallMs = performance.now() - firstStart;

  const { elapsedMs, avgCallMs, vectors } = await runGroups(extractor);
  await extractor.dispose?.();

  let minCos = 1;
  let meanCos = 1;
  if (reference) {
    const sims = vectors.map((v, i) => dot(v, reference[i]));
    minCos = Math.min(...sims);
    meanCos = sims.reduce((a, b) => a + b, 0) / sims.length;
  } else {
    reference = vectors;
  }

  console.log('done');
  rows.push({
    device,
    loadS: (loadMs / 1000).toFixed(1),
    firstCallMs: firstCallMs.toFixed(0),
    avgCallMs: avgCallMs.toFixed(1), // comparable to the build table's "Embed ms"
    textsPerSec: ((texts.length / elapsedMs) * 1000).toFixed(0),
    minCos: minCos.toFixed(5),
    meanCos: meanCos.toFixed(5),
  });
}

console.log(`\n${texts.length} texts, groups of ${GROUP_SIZE}, ${IN_FLIGHT} calls in flight:\n`);
console.table(rows);
console.log('Pick the fastest device whose minCos stays above ~0.999, then set EMBED_DEVICE=<device> in env.local.');
