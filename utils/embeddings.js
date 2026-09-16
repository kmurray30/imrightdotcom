/**
 * Local text embeddings via a small ONNX model running in-process — no
 * vendor API, no per-call cost. Used both by the offline index build/refresh
 * scripts and by wiki_searcher/providers/wikimedia.js at query time.
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

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_NAME);
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
