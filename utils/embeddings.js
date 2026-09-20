/**
 * CLIP text/image embeddings, run locally (no per-call API cost — the
 * image-search alternative to sending every image to an LLM captioning API).
 * A CLIP model has two encoders trained into the same vector space: embed an
 * image with one, embed unrelated text with the other, and cosine similarity
 * between the two is still meaningful. That's what makes "search images by
 * typing a description" possible here.
 *
 * Uses @xenova/transformers rather than the newer, actively-maintained
 * @huggingface/transformers: the latter's onnxruntime-node dependency fetches
 * its native binary via NuGet (api.nuget.org) at install time, which this
 * project's dev/build environment could not reach; @xenova/transformers pulls
 * an older onnxruntime-node with no such dependency, verified to install
 * cleanly. Revisit if @huggingface/transformers's install story changes —
 * it's the better long-term choice once that's no longer a blocker.
 *
 * IMPORTANT — NOT VERIFIED END TO END. Model weights are fetched from
 * huggingface.co at runtime; that host was unreachable in the environment
 * this was written in, so nothing in this file has actually been run against
 * the real model. The API shapes below (CLIPTextModelWithProjection /
 * CLIPVisionModelWithProjection, tokenizer/processor call signatures,
 * text_embeds/image_embeds output fields) match transformers.js's documented
 * CLIP usage, but "documented" isn't "tested here". First real deploy: embed
 * one known image and one obviously-matching text description, confirm the
 * cosine similarity actually looks like a match (roughly 0.2-0.35+ for a
 * genuine match is the usual ballpark for CLIP ViT-B/32) before trusting any
 * of the search logic built on top of this.
 */

import sharp from 'sharp';
import {
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from '@xenova/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const EMBEDDING_MODEL_NAME = MODEL_ID;
export const EMBEDDING_DIMENSIONS = 512; // ViT-B/32 projection dimension

/** Call once, before any embed*() call, to keep downloaded model weights on
 * a persistent volume instead of re-downloading them on every deploy. */
export function setModelCacheDir(dir) {
  env.cacheDir = dir;
}

let loadPromise = null;
function loadModel() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoProcessor.from_pretrained(MODEL_ID),
      CLIPTextModelWithProjection.from_pretrained(MODEL_ID),
      CLIPVisionModelWithProjection.from_pretrained(MODEL_ID),
    ]).then(([tokenizer, processor, textModel, visionModel]) => ({
      tokenizer,
      processor,
      textModel,
      visionModel,
    }));
  }
  return loadPromise;
}

function normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Embed a text description into CLIP's shared vector space (L2-normalized). */
export async function embedText(text) {
  const { tokenizer, textModel } = await loadModel();
  const inputs = tokenizer(text, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return normalize(Float32Array.from(text_embeds.data));
}

/**
 * Embed an image file into CLIP's shared vector space (L2-normalized).
 * Decodes via our own `sharp` rather than the library's bundled image
 * loader, so this never touches @xenova/transformers's own nested (and
 * currently audit-flagged) copy of sharp.
 */
export async function embedImageFile(filePath) {
  const { processor, visionModel } = await loadModel();
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawImage = new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
  const inputs = await processor(rawImage);
  const { image_embeds } = await visionModel(inputs);
  return normalize(Float32Array.from(image_embeds.data));
}

/** Both inputs are assumed L2-normalized (embedText/embedImageFile always return normalized
 * vectors), so this is just a dot product, not full cosine-similarity math. */
export function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/** DataView-based (not a raw typed-array cast) because a Buffer read back from a SQLite
 * BLOB column can have a byteOffset Float32Array alignment doesn't tolerate. */
export function bufferToVector(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function vectorToBuffer(vec) {
  const buf = Buffer.alloc(vec.length * Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
