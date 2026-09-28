/**
 * Local text embeddings via a small ONNX model running in-process — no
 * vendor API, no per-call cost. Used both by the offline index build/refresh
 * scripts and by wiki_searcher/providers/wikimedia.js at query time.
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
import { pipeline } from '@huggingface/transformers';

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;

let extractorPromise = null;
let log = console.log;

/**
 * Redirects this module's own progress logging (model download, below) away
 * from the console — e.g. to a log file — without changing what gets logged.
 * Defaults to console.log, so nothing changes for callers that never call
 * this (providers/wikimedia.js at live query time, refresh-daily.js).
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
function getExtractor() {
  if (!extractorPromise) {
    const lastLoggedPct = {}; // per-file, so multi-file downloads (model + tokenizer) don't spam past each other
    extractorPromise = pipeline('feature-extraction', MODEL_NAME, {
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
      log('[embed] Model ready.');
      return extractor;
    });
  }
  return extractorPromise;
}

/**
 * Embeds many texts in ONE forward pass instead of one at a time. The
 * feature-extraction pipeline tokenizes the whole array together (padded to
 * a common length) and runs a single batched pass through the model —
 * verified against transformers.js's own source (FeatureExtractionPipeline
 * ._call in src/pipelines.js): passing an array skips straight to one
 * `this.model(model_inputs)` call, not one per item. For a small model like
 * this, most of the per-call cost is fixed overhead (tokenizer dispatch,
 * tensor allocation, thread-pool handoff into the native ONNX runtime), not
 * the matmul itself — so batching is a much bigger lever than firing off N
 * separate calls, even N concurrent ones.
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
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

/**
 * @param {string} text
 * @returns {Promise<number[]>} A unit-normalized embedding vector, length EMBEDDING_DIMENSIONS.
 */
export async function embedText(text) {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
