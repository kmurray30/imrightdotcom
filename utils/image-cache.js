/**
 * Persistent Pixabay image cache, now with three stages:
 *
 *  0. Embedding index (image_embeddings + an in-memory vector map): a rich
 *     text description is embedded with CLIP and compared against every
 *     stored image's own CLIP embedding. A close-enough match reuses that
 *     image directly — no Pixabay call at all. This is the only stage keyed
 *     by *meaning* rather than literal text; the fallback below never is.
 *  1. search_cache: normalized simple query -> Pixabay's own ranked list of
 *     image IDs. Only reached on an embedding-index miss, using a short,
 *     dead-simple term (not the rich description). Refreshed lazily
 *     (read-time TTL check, no cron) at most once per 24h per query, matching
 *     Pixabay's "requests must be cached for 24 hours" rule.
 *  2. images: image ID -> metadata (populated for free from every hit in a
 *     search response, not just rank 0) and, once actually selected for use,
 *     a downloaded + recompressed file. Pixabay disallows permanent hotlinking
 *     ("If you intend to use the images, please download them to your server
 *     first"), so the file is what callers ultimately serve. Shared by both
 *     stage 0 (every embedded image already has a file — you can't embed
 *     bytes you haven't downloaded) and stage 1's fallback.
 *
 * Embeddings live in their own table, not as a column on images: a plain
 * "get file by id" lookup should never need to touch — or even know about —
 * a multi-KB vector blob or the brute-force similarity scan that reads them.
 * Same underlying 1:1 relationship, cleanly separated concerns.
 *
 * Stage 1 selection always takes Pixabay's own rank 0 for the exact
 * normalized simple query — never a different rank picked by tag/metadata
 * heuristics. Stage 0 never keys off tags either — only a stored image's own
 * embedding, compared against the query's embedding.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { searchImages, downloadImage } from './pixabay.js';
import {
  embedText,
  embedImageFile,
  cosineSimilarity,
  bufferToVector,
  vectorToBuffer,
  setModelCacheDir,
  EMBEDDING_MODEL_NAME,
} from './embeddings.js';
import { log, recordImageCacheLookup, recordEmbeddingSearch, recordEmbeddingLatency } from '../imright/scripts/observability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Point IMAGE_CACHE_DIR at a Railway volume in production so the cache
// survives redeploys. Falls back to a local dir (already gitignored via
// tabloid_generator/images/) for dev.
const CACHE_DIR = process.env.IMAGE_CACHE_DIR
  ? path.resolve(process.env.IMAGE_CACHE_DIR)
  : path.join(PROJECT_ROOT, 'tabloid_generator', 'images', '.cache');
const FILES_DIR = path.join(CACHE_DIR, 'by-id');
const DB_PATH = path.join(CACHE_DIR, 'pixabay-cache.sqlite');
// CLIP model weights land here on first use and are reused across restarts —
// same volume as everything else, so they're not re-downloaded on every deploy.
const MODEL_CACHE_DIR = path.join(CACHE_DIR, 'models');

// A per-article article's *chosen* images are copied out of this cache (see
// fetchAndDownloadImages in tabloid_generator/index.js) into a permanent
// location this module's own sweep (runMaintenanceIfDue, below) never
// touches — sibling to CACHE_DIR so it lands on the same mounted volume in
// prod (IMAGE_CACHE_DIR), not on the ephemeral container filesystem, which
// is what made those copies non-durable before this existed. Exported so the
// pipeline doesn't need to know or duplicate this volume-path logic.
export function getArticleImagesRoot() {
  return process.env.IMAGE_CACHE_DIR
    ? path.join(path.dirname(CACHE_DIR), 'article-images')
    : path.join(PROJECT_ROOT, 'tabloid_generator', 'images');
}

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
// Disk-cost hygiene only — Pixabay imposes no retention limit on images
// you've legitimately downloaded. No separate job/service: this just runs
// inline, at most once per PRUNE_INTERVAL_MS, wherever the cache is opened
// (works whether the caller is the long-running server or a one-off CLI run).
const FILE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// How close a query's embedding must be to a stored image's embedding to reuse
// it instead of asking Pixabay. NOT empirically tuned — chosen from general CLIP
// ViT-B/32 knowledge (genuine matches are commonly reported in the ~0.2-0.35+
// cosine range), not measured against this app's real queries. Watch the
// imright_image_cache_embedding_similarity histogram once real traffic exists
// and adjust; too high starves the local corpus of hits (nothing ever seems
// "close enough"), too low serves weak matches and never improves.
const EMBEDDING_SIMILARITY_THRESHOLD = Number(process.env.IMAGE_CACHE_SIMILARITY_THRESHOLD ?? 0.28);

// Disk-cost warning only, not a Pixabay rule (same as FILE_RETENTION_MS above) —
// logged at most once per maintenance sweep, not once per request.
const SIZE_WARNING_BYTES = Number(process.env.IMAGE_CACHE_SIZE_WARNING_BYTES ?? 2 * 1024 * 1024 * 1024);

setModelCacheDir(MODEL_CACHE_DIR);

let db = null;
// In-memory mirror of image_embeddings, rebuilt from SQLite on cold start and
// appended to on every write. Brute-force cosine search over this (not a SQL
// scan re-parsing BLOBs every time) is what stage 0 actually searches — fine
// at the scale this app deals with (see the design discussion this came out
// of: low tens of thousands of images, comfortably sub-100ms in JS).
let vectorIndex = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_cache (
      query TEXT PRIMARY KEY,
      image_ids TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY,
      tags TEXT,
      metadata TEXT NOT NULL,
      metadata_fetched_at INTEGER NOT NULL,
      file_path TEXT,
      file_size_bytes INTEGER,
      downloaded_at INTEGER,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS image_embeddings (
      image_id INTEGER PRIMARY KEY REFERENCES images(id),
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      embedded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  runMaintenanceIfDue();
  return db;
}

function getVectorIndex(database) {
  if (vectorIndex) return vectorIndex;
  vectorIndex = new Map();
  const rows = database.prepare('SELECT image_id, embedding FROM image_embeddings').all();
  for (const row of rows) {
    vectorIndex.set(row.image_id, bufferToVector(row.embedding));
  }
  return vectorIndex;
}

/** Ranked (desc) list of { id, score } across every embedded image — a full
 * scan, not a point lookup. Callers only ever need the top few. */
function searchVectorIndex(database, queryVector) {
  const index = getVectorIndex(database);
  const scored = [];
  for (const [id, vector] of index) {
    scored.push({ id, score: cosineSimilarity(queryVector, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function storeEmbedding(database, imageId, vector) {
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO image_embeddings (image_id, embedding, model, embedded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(image_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model, embedded_at = excluded.embedded_at`
    )
    .run(imageId, vectorToBuffer(vector), EMBEDDING_MODEL_NAME, now);
  getVectorIndex(database).set(imageId, vector);
}

function normalizeQuery(rawQuery) {
  return rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSearchCacheRow(database, query) {
  return database.prepare('SELECT image_ids, fetched_at FROM search_cache WHERE query = ?').get(query);
}

function upsertSearchCache(database, query, imageIds) {
  database
    .prepare(
      `INSERT INTO search_cache (query, image_ids, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(query) DO UPDATE SET image_ids = excluded.image_ids, fetched_at = excluded.fetched_at`
    )
    .run(query, JSON.stringify(imageIds), Date.now());
}

function upsertImageMetadata(database, hits) {
  const now = Date.now();
  const existsStmt = database.prepare('SELECT 1 FROM images WHERE id = ?');
  const upsertStmt = database.prepare(
    `INSERT INTO images (id, tags, metadata, metadata_fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tags = excluded.tags, metadata = excluded.metadata, metadata_fetched_at = excluded.metadata_fetched_at`
  );
  for (const hit of hits) {
    // Metadata "hit" = this image ID was already known from a previous, different
    // search — i.e. cross-query dedup actually paying off; "miss" = brand new.
    const alreadyKnown = !!existsStmt.get(hit.id);
    recordImageCacheLookup({ tier: 'metadata', result: alreadyKnown ? 'hit' : 'miss' });
    upsertStmt.run(hit.id, hit.tags ?? '', JSON.stringify(hit), now);
  }
}

async function downloadAndCompress(sourceUrl, destPath) {
  const tmpPath = `${destPath}.download-${process.pid}-${Date.now()}`;
  await downloadImage(sourceUrl, tmpPath);
  try {
    await sharp(tmpPath)
      .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 45 })
      .toFile(destPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function ensureImageFile(database, id) {
  const row = database.prepare('SELECT metadata, file_path FROM images WHERE id = ?').get(id);
  if (!row) return null;

  const now = Date.now();
  if (row.file_path && fs.existsSync(row.file_path)) {
    recordImageCacheLookup({ tier: 'file', result: 'hit' });
    database.prepare('UPDATE images SET last_used_at = ? WHERE id = ?').run(now, id);
    return { id, filePath: row.file_path };
  }
  recordImageCacheLookup({ tier: 'file', result: 'miss' });

  const metadata = JSON.parse(row.metadata);
  const sourceUrl = metadata.webformatURL ?? metadata.largeImageURL;
  if (!sourceUrl) return null;

  const filePath = path.join(FILES_DIR, `${id}.webp`);
  try {
    await downloadAndCompress(sourceUrl, filePath);
  } catch (error) {
    console.error(`Image download/compress failed for Pixabay id ${id}:`, error?.message ?? error);
    return null;
  }

  const fileSizeBytes = fs.statSync(filePath).size;
  database
    .prepare('UPDATE images SET file_path = ?, file_size_bytes = ?, downloaded_at = ?, last_used_at = ? WHERE id = ?')
    .run(filePath, fileSizeBytes, now, now, id);
  return { id, filePath };
}

/**
 * Fall back to Pixabay search with a short, dead-simple term — never the rich
 * embedding-search description. Unchanged from before the embedding index
 * existed: exact-normalized-string memo cache, Pixabay's own rank 0 only.
 */
async function getImageBySimpleQuery(database, rawSimpleQuery) {
  const query = normalizeQuery(rawSimpleQuery);
  if (!query) return null;

  const cached = getSearchCacheRow(database, query);
  const isFresh = cached && Date.now() - cached.fetched_at < SEARCH_TTL_MS;
  recordImageCacheLookup({ tier: 'search', result: isFresh ? 'hit' : 'miss' });

  let imageIds = isFresh ? JSON.parse(cached.image_ids) : null;
  if (!imageIds) {
    const hits = await searchImages(query);
    if (hits) {
      imageIds = hits.map((hit) => hit.id);
      upsertSearchCache(database, query, imageIds);
      upsertImageMetadata(database, hits);
    } else if (cached) {
      // Pixabay search failed/rate-limited: fall back to this exact query's
      // own stale result rather than returning nothing.
      log('warn', 'image_cache search fallback to stale', { query, ageMs: Date.now() - cached.fetched_at });
      imageIds = JSON.parse(cached.image_ids);
    }
  }
  if (!imageIds || imageIds.length === 0) return null;

  return ensureImageFile(database, imageIds[0]);
}

function runMaintenanceIfDue() {
  const row = db.prepare("SELECT value FROM cache_meta WHERE key = 'last_swept_at'").get();
  const lastSweptAt = row ? Number(row.value) : 0;
  if (Date.now() - lastSweptAt < PRUNE_INTERVAL_MS) return;

  const cutoff = Date.now() - FILE_RETENTION_MS;
  const staleFiles = db
    .prepare('SELECT id, file_path FROM images WHERE file_path IS NOT NULL AND last_used_at < ?')
    .all(cutoff);
  for (const stale of staleFiles) {
    try {
      fs.unlinkSync(stale.file_path);
    } catch {
      // Already gone — fine.
    }
    db.prepare('UPDATE images SET file_path = NULL, downloaded_at = NULL WHERE id = ?').run(stale.id);
    // An embedding pointing at a file that no longer exists would otherwise let
    // stage 0 keep "finding" an image it can't actually serve without a
    // re-download (and Pixabay's URLs are only valid ~24h, so that often fails).
    db.prepare('DELETE FROM image_embeddings WHERE image_id = ?').run(stale.id);
    vectorIndex?.delete(stale.id);
  }
  db.prepare('DELETE FROM search_cache WHERE fetched_at < ?').run(cutoff);

  db.prepare(
    `INSERT INTO cache_meta (key, value) VALUES ('last_swept_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()));

  const { bytes } = db
    .prepare('SELECT COALESCE(SUM(file_size_bytes), 0) AS bytes FROM images WHERE file_path IS NOT NULL')
    .get();
  if (bytes >= SIZE_WARNING_BYTES) {
    log('warn', 'image cache size exceeds warning threshold', {
      downloadedBytes: bytes,
      thresholdBytes: SIZE_WARNING_BYTES,
    });
  }
}

/**
 * Get a cached (or freshly resolved) image for an article/section.
 *
 * @param {object} params
 * @param {string} [params.richDescription] - Fuller description for the
 *   embedding-index search. Optional — without it, stage 0 is skipped and
 *   this behaves exactly like the pre-embedding-index cache.
 * @param {string} params.simpleQuery - Short, literal Pixabay search term
 *   (the existing photo_query field) — the stage 1 fallback key. Required.
 * @returns {Promise<{ id: number, filePath: string } | null>}
 */
export async function getCachedImage({ richDescription, simpleQuery }) {
  if (typeof simpleQuery !== 'string' || !simpleQuery.trim()) return null;
  const database = getDb();

  if (typeof richDescription === 'string' && richDescription.trim()) {
    const embedStart = performance.now();
    let queryVector;
    try {
      queryVector = await embedText(richDescription.trim());
    } catch (error) {
      log('warn', 'embedding-index query embedding failed, falling back to Pixabay search', {
        error: error?.message ?? String(error),
      });
      queryVector = null;
    }
    if (queryVector) {
      recordEmbeddingLatency({ kind: 'query', ms: performance.now() - embedStart });

      const ranked = searchVectorIndex(database, queryVector);
      recordEmbeddingSearch({ top1: ranked[0]?.score, top2: ranked[1]?.score, top3: ranked[2]?.score });

      const best = ranked[0];
      if (best && best.score >= EMBEDDING_SIMILARITY_THRESHOLD) {
        recordImageCacheLookup({ tier: 'embedding', result: 'hit' });
        const resolved = await ensureImageFile(database, best.id);
        // Normally never null (an embedded image always has a file by construction),
        // except the rare case its file was since pruned and re-download failed
        // (stale Pixabay URL) — fall through to stage 1 rather than give up.
        if (resolved) return resolved;
      } else {
        recordImageCacheLookup({ tier: 'embedding', result: 'miss' });
      }
    }
  }

  return getImageBySimpleQuery(database, simpleQuery);
}

/**
 * Compute + store embeddings for any downloaded images that don't have one
 * yet, up to `limit`. Meant to run deferred, after a page has already been
 * shown to the visitor (see imright/index.js) — never on the request path,
 * since a miss's Pixabay round-trip already dwarfs one embedding's cost, but
 * there's no reason to make the visitor wait on it at all when it only
 * benefits *future* lookups. Self-healing rather than per-request-tracked:
 * it just picks up whatever's missing, so a failed/skipped embedding gets
 * retried on the next call rather than needing explicit resumption state.
 *
 * @param {object} [options]
 * @param {number} [options.limit] - Max images to embed in one call.
 * @returns {Promise<{ embedded: number, failed: number }>}
 */
export async function backfillImageEmbeddings({ limit = 10 } = {}) {
  const database = getDb();
  const pending = database
    .prepare(
      `SELECT id, file_path FROM images
       WHERE file_path IS NOT NULL AND id NOT IN (SELECT image_id FROM image_embeddings)
       ORDER BY downloaded_at ASC LIMIT ?`
    )
    .all(limit);

  let embedded = 0;
  let failed = 0;
  for (const row of pending) {
    const start = performance.now();
    try {
      const vector = await embedImageFile(row.file_path);
      recordEmbeddingLatency({ kind: 'image', ms: performance.now() - start });
      storeEmbedding(database, row.id, vector);
      embedded++;
    } catch (error) {
      failed++;
      log('warn', 'image embedding creation failed', { imageId: row.id, error: error?.message ?? String(error) });
    }
  }
  return { embedded, failed };
}

/**
 * Point-in-time cache size stats, for periodic metrics reporting (see
 * imright/scripts/observability.js). Cheap enough to call every heartbeat:
 * a handful of COUNT/SUM queries over a small local SQLite file, plus one
 * fs.statSync for the DB file itself.
 *
 * @returns {{
 *   searchCacheQueries: number,        // stage 1: distinct cached queries ("source")
 *   searchCacheDistinctImages: number, // stage 1: distinct top-ranked images referenced ("destination")
 *   metadataImages: number,            // stage 2: distinct Pixabay IDs with metadata cached
 *   downloadedImages: number,          // stage 2: distinct images actually downloaded to disk
 *   downloadedBytes: number,           // stage 2: total bytes of downloaded/compressed files
 *   dbFileBytes: number,               // size of the SQLite file itself
 *   embeddedImages: number,            // stage 0: distinct images with a stored embedding
 * }}
 */
export function getCacheStats() {
  const database = getDb();

  const searchRows = database.prepare('SELECT image_ids FROM search_cache').all();
  const distinctTopImageIds = new Set(
    searchRows.map((row) => JSON.parse(row.image_ids)[0]).filter((id) => id != null)
  );

  const metadataImages = database.prepare('SELECT COUNT(*) AS n FROM images').get().n;
  const fileStats = database
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(file_size_bytes), 0) AS bytes FROM images WHERE file_path IS NOT NULL')
    .get();
  const embeddedImages = database.prepare('SELECT COUNT(*) AS n FROM image_embeddings').get().n;

  let dbFileBytes = 0;
  try {
    dbFileBytes = fs.statSync(DB_PATH).size;
  } catch {
    // DB file doesn't exist yet — fine, report 0.
  }

  return {
    searchCacheQueries: searchRows.length,
    searchCacheDistinctImages: distinctTopImageIds.size,
    metadataImages,
    downloadedImages: fileStats.n,
    downloadedBytes: fileStats.bytes,
    dbFileBytes,
    embeddedImages,
  };
}
