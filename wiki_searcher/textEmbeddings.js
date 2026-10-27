/**
 * Local text embeddings via a small ONNX model running in-process — no
 * vendor API, no per-call cost. Used both by the offline index build/refresh
 * scripts and, through arcticEmbeddings.js, by wiki_searcher/spanSearch.js at
 * query time.
 *
 * Not utils/embeddings.js — that's a separate, unrelated CLIP text/image
 * module for the Pixabay image cache. This one is specific to the wiki
 * paragraph vector index, hence living under wiki_searcher/ instead.
 *
 * The model here MUST always match whatever built the vector index in
 * Postgres (wiki_paragraph_embeddings.embedding) — vectors from different
 * models aren't comparable. If this ever changes, the whole index needs
 * rebuilding, not just new rows appended.
 */
import { pipeline, env } from '@huggingface/transformers';

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Runtime knobs (pick values with scripts/benchmark-embed-device.js):
 *  - EMBED_DEVICE: ONNX Runtime device — 'cpu' (default); on a Mac 'webgpu'
 *    or 'coreml', on Linux x64 'cuda'. Speed only; vectors are unchanged.
 *  - EMBED_DTYPE: model precision — 'fp32' (default, what the index was built
 *    with). 'fp16' can be faster on a GPU but produces slightly different
 *    vectors: only use it if the benchmark's parity check (cosine against the
 *    vectors already stored in the index) stays above ~0.999.
 *  - EMBED_THREADS: CPU threads for the model when EMBED_DEVICE=cpu (default:
 *    ONNX Runtime's own choice, i.e. all cores). Cap it when other processes
 *    share the machine, e.g. a CPU build worker next to GPU ones.
 *  - EMBED_BATCH_SIZE: max texts per model call (default 8) — see embedSorted.
 *    Benchmarked on real index paragraphs: 8-16 was fastest on both CPU and
 *    WebGPU; 64 was ~3x slower on both (padding waste swamped everything).
 * A function, not constants: callers import this module before loadEnv() has
 * read env.local, so these must be read when the model is actually used.
 */
export function embedConfig() {
  return {
    device: process.env.EMBED_DEVICE || 'cpu',
    dtype: process.env.EMBED_DTYPE || 'fp32',
    batchSize: Number(process.env.EMBED_BATCH_SIZE) || 8,
    threads: Number(process.env.EMBED_THREADS) || 0,
  };
}

let extractorPromise = null;
let log = console.log;

/**
 * Redirects this module's own progress logging (model download, below) away
 * from the console — e.g. to a log file — without changing what gets logged.
 * Defaults to console.log, so nothing changes for callers that never call
 * this (spanSearch.js at live query time, refresh-daily.js).
 * build-index-from-wikimedia.js uses this to keep its terminal output to
 * just the aggregate progress bar, funneling the one-time model-download
 * detail into its own debug.log instead.
 */
export function setLogger(fn) {
  log = fn;
}

/**
 * The first call in any process pulls model weights from Hugging Face Hub if
 * they're not already cached locally (a one-time ~100MB download) — with no
 * progress_callback wired up, transformers.js does this in total silence, no
 * console output at all, which looks identical to a genuine hang for however
 * long the download takes. Logging start/progress/done here isn't cosmetic:
 * it's the difference between "waiting on a slow download" and "is this
 * broken" being answerable at a glance instead of requiring lsof.
 *
 * Event shapes below (status: 'initiate'|'download'|'progress'|'done', plus
 * file/progress/loaded/total on the relevant ones) confirmed against
 * @huggingface/transformers 4.3.0's actual source (src/utils/hub.js,
 * src/utils/hub/utils.js) rather than assumed from docs.
 */
export function loadExtractor(device, dtype, modelName = MODEL_NAME) {
  // On Railway: a path on the service's volume, so the weights survive redeploys.
  if (process.env.EMBED_MODEL_CACHE_DIR) env.cacheDir = process.env.EMBED_MODEL_CACHE_DIR;
  const lastLoggedPct = {}; // per-file, so multi-file downloads (model + tokenizer) don't spam past each other
  const { threads } = embedConfig();
  log(`[embed] Loading ${modelName} on ${device} (${dtype}${device === 'cpu' && threads ? `, ${threads} threads` : ''})...`);
  return pipeline('feature-extraction', modelName, {
    device,
    // Forwarded by transformers.js to onnxruntime's InferenceSession.create.
    ...(device === 'cpu' && threads > 0 ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}),
    // Always passed explicitly rather than left to transformers.js's
    // per-device default, so a device switch can never silently load a
    // different (e.g. quantized) model file than the index was built with.
    dtype,
    progress_callback: (progress) => {
      if (progress.status === 'initiate') {
        log(`[embed] Downloading ${progress.file} (first use only, cached after this)...`);
      } else if (progress.status === 'progress' && progress.file && typeof progress.progress === 'number') {
        const pct = Math.floor(progress.progress / 10) * 10; // log every ~10%, not every stream chunk
        if (pct > (lastLoggedPct[progress.file] ?? -10)) {
          lastLoggedPct[progress.file] = pct;
          log(`[embed]   ${progress.file}: ${pct}%`);
        }
      } else if (progress.status === 'done' && progress.file) {
        log(`[embed]   ${progress.file}: done`);
      }
    },
  }).then((extractor) => {
    log(`[embed] Model ready (${modelName}, device: ${device}, dtype: ${dtype}).`);
    return extractor;
  });
}

function getExtractor() {
  if (!extractorPromise) {
    const { device, dtype } = embedConfig();
    extractorPromise = loadExtractor(device, dtype);
  }
  return extractorPromise;
}

/**
 * Embeds many texts in a few batched forward passes (see embedSorted for how
 * they're grouped) instead of one at a time. The
 * feature-extraction pipeline tokenizes the whole array together (padded to
 * a common length) and runs a single batched pass through the model —
 * verified against transformers.js's own source (FeatureExtractionPipeline
 * ._call in src/pipelines.js): passing an array skips straight to one
 * `this.model(model_inputs)` call, not one per item. For a small model like
 * this, most of the per-call cost is fixed overhead (tokenizer dispatch,
 * tensor allocation, thread-pool handoff into the native ONNX runtime), not
 * the matmul itself — so batching is a much bigger lever than firing off N
 * separate calls, even N concurrent ones. Even more so on a GPU: measured
 * on WebGPU, 5-text calls only got ~3x over CPU, because per-call overhead
 * swamped the actual compute.
 *
 * Returns embeddings in the same order as `texts`. Uses the Tensor's own
 * `.tolist()` (reshapes its flat data by `.dims`) rather than reading `.data`
 * directly — for a batch, `.data` is one flat Float32Array covering every
 * item, and slicing it correctly by hand isn't worth the risk when `.tolist()`
 * already does it.
 * @param {string[]} texts
 * @returns {Promise<number[][]>} One unit-normalized embedding vector per input text, each length EMBEDDING_DIMENSIONS.
 */
export async function embedTexts(texts) {
  if (texts.length === 0) return [];
  return embedSorted(await getExtractor(), texts, embedConfig().batchSize);
}

/**
 * Sorts texts by length, cuts them into model calls of at most `batchSize`,
 * and scatters the vectors back to input order. Every text in a call is
 * padded to that call's longest one, and real Wikipedia paragraphs range from
 * one line to the model's 512-token limit — so one long paragraph in a call
 * of short ones makes most of that call's compute padding. Smaller
 * length-sorted calls keep each call's lengths similar (less padding) at the
 * cost of more per-call overhead; the cap also bounds GPU memory (attention
 * grows with batch × sequence²). The right `batchSize` depends on the device —
 * benchmark-embed-device.js sweeps it, calling this same function.
 */
export async function embedSorted(extractor, texts, batchSize, pooling = 'mean') {
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const results = new Array(texts.length);
  for (let start = 0; start < order.length; start += batchSize) {
    const indices = order.slice(start, start + batchSize);
    const output = await extractor(indices.map((i) => texts[i]), { pooling, normalize: true });
    output.tolist().forEach((vector, j) => {
      results[indices[j]] = vector;
    });
  }
  return results;
}

/**
 * @param {string} text
 * @returns {Promise<number[]>} A unit-normalized embedding vector, length EMBEDDING_DIMENSIONS.
 */
export async function embedText(text) {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
