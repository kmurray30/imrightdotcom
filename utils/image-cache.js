/**
 * Persistent Pixabay cache, keyed strictly by literal search text — never by
 * an image's own tags, so a "milk" query can never resolve to a "cow" result
 * just because the cow photo happens to be tagged "milk".
 *
 * Two tables:
 *  - search_cache: normalized query -> Pixabay's own ranked list of image IDs.
 *    Refreshed lazily (read-time TTL check, no cron) at most once per 24h per
 *    query, matching Pixabay's "requests must be cached for 24 hours" rule.
 *  - images: image ID -> metadata (populated for free from every hit in a
 *    search response, not just rank 0) and, once actually selected for use,
 *    a downloaded + recompressed file. Pixabay disallows permanent hotlinking
 *    ("If you intend to use the images, please download them to your server
 *    first"), so the file is what callers ultimately serve.
 *
 * Selection always takes rank 0 of whatever search_cache holds for a query —
 * never a different rank chosen by tag/metadata heuristics.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { searchImages, downloadImage } from './pixabay.js';

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

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
// Disk-cost hygiene only — Pixabay imposes no retention limit on images
// you've legitimately downloaded. No separate job/service: this just runs
// inline, at most once per PRUNE_INTERVAL_MS, wherever the cache is opened
// (works whether the caller is the long-running server or a one-off CLI run).
const FILE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let db = null;

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
      downloaded_at INTEGER,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  runMaintenanceIfDue();
  return db;
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
  const stmt = database.prepare(
    `INSERT INTO images (id, tags, metadata, metadata_fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tags = excluded.tags, metadata = excluded.metadata, metadata_fetched_at = excluded.metadata_fetched_at`
  );
  for (const hit of hits) {
    stmt.run(hit.id, hit.tags ?? '', JSON.stringify(hit), now);
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
    database.prepare('UPDATE images SET last_used_at = ? WHERE id = ?').run(now, id);
    return { id, filePath: row.file_path };
  }

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

  database
    .prepare('UPDATE images SET file_path = ?, downloaded_at = ?, last_used_at = ? WHERE id = ?')
    .run(filePath, now, now, id);
  return { id, filePath };
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
  }
  db.prepare('DELETE FROM search_cache WHERE fetched_at < ?').run(cutoff);

  db.prepare(
    `INSERT INTO cache_meta (key, value) VALUES ('last_swept_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()));
}

/**
 * Get a cached (or freshly searched/downloaded/compressed) image for a query.
 * Always takes Pixabay's own top-ranked hit for the exact normalized query —
 * never a different rank picked by tag overlap with other cached images.
 *
 * @param {string} rawQuery
 * @returns {Promise<{ id: number, filePath: string } | null>}
 */
export async function getCachedImage(rawQuery) {
  if (typeof rawQuery !== 'string') return null;
  const query = normalizeQuery(rawQuery);
  if (!query) return null;

  const database = getDb();
  const cached = getSearchCacheRow(database, query);
  const isFresh = cached && Date.now() - cached.fetched_at < SEARCH_TTL_MS;

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
      imageIds = JSON.parse(cached.image_ids);
    }
  }
  if (!imageIds || imageIds.length === 0) return null;

  return ensureImageFile(database, imageIds[0]);
}
