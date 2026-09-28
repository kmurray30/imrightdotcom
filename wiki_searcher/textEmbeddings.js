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
          console.log(`[embed] Downloading ${progress.file} (first use only, cached after this)...`);
        } else if (progress.status === 'progress' && progress.file && typeof progress.progress === 'number') {
          const pct = Math.floor(progress.progress / 10) * 10; // log every ~10%, not every stream chunk
          if (pct > (lastLoggedPct[progress.file] ?? -10)) {
            lastLoggedPct[progress.file] = pct;
            console.log(`[embed]   ${progress.file}: ${pct}%`);
          }
        } else if (progress.status === 'done' && progress.file) {
          console.log(`[embed]   ${progress.file}: done`);
        }
      },
    }).then((extractor) => {
      console.log('[embed] Model ready.');
      return extractor;
    });
  }
  return extractorPromise;
}

/**
 * @param {string} text
 * @returns {Promise<number[]>} A unit-normalized embedding vector, length EMBEDDING_DIMENSIONS.
 */
export async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
