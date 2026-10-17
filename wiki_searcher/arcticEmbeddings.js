/**
 * Snowflake arctic-embed-m-v1.5: the compact-index replacement for
 * bge-small (textEmbeddings.js). Trained (Matryoshka) so its 768-dim vectors
 * can be cut to their first 256 dims and re-normalized with little quality
 * loss, which is what's stored — wiki_paragraph_vectors_arctic, halfvec(256).
 *
 * Passages and queries must be embedded exactly the same way as here (same
 * model, CLS pooling, truncation), or their vectors aren't comparable. Only
 * queries get QUERY_PREFIX; passages are embedded as-is.
 *
 * Device/dtype/batch size come from the same EMBED_* settings as bge
 * (textEmbeddings.js's embedConfig).
 */
import { embedConfig, embedSorted, loadExtractor } from './textEmbeddings.js';

export const ARCTIC_MODEL = 'Snowflake/snowflake-arctic-embed-m-v1.5';
export const ARCTIC_DIMS = 256;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    const { device, dtype } = embedConfig();
    extractorPromise = loadExtractor(device, dtype, ARCTIC_MODEL);
  }
  return extractorPromise;
}

/** First ARCTIC_DIMS components, re-normalized to unit length (Matryoshka truncation). */
function truncate(vector) {
  const out = new Float32Array(ARCTIC_DIMS);
  let norm = 0;
  for (let i = 0; i < ARCTIC_DIMS; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < ARCTIC_DIMS; i++) out[i] = vector[i] / norm;
  return out;
}

/**
 * @param {string[]} texts - Passages, in the index's "{title} — {section}: {text}" form.
 * @returns {Promise<Float32Array[]>} One unit-length ARCTIC_DIMS vector per text, in input order.
 */
export async function embedPassages(texts) {
  if (texts.length === 0) return [];
  const vectors = await embedSorted(await getExtractor(), texts, embedConfig().batchSize, 'cls');
  return vectors.map(truncate);
}

/** @returns {Promise<Float32Array>} The query's unit-length ARCTIC_DIMS vector (QUERY_PREFIX applied here). */
export async function embedQuery(text) {
  const [vector] = await embedSorted(await getExtractor(), [QUERY_PREFIX + text], 1, 'cls');
  return truncate(vector);
}
