/**
 * Persists generated pages forever in Postgres (see schema.sql) so a link to
 * a page keeps working without re-running the pipeline. Each page is a
 * small record — article text, citations, and hotlinked image URLs, no
 * binary assets — which is what keeps this cheap to store indefinitely.
 */

import crypto from 'crypto';
import { slugify } from '../utils.js';
import { query } from './db.js';

const PAGE_ID_PATTERN = /^[a-z0-9-]+$/;

/** @param {string} pageId */
export function isValidPageId(pageId) {
  return typeof pageId === 'string' && pageId.length > 0 && pageId.length <= 200 && PAGE_ID_PATTERN.test(pageId);
}

/**
 * Mint a page id: `<readable-slug>-<8 hex chars>`. The hex suffix is what
 * guarantees uniqueness — two people generating the same claim just get
 * different suffixes — so there's no separate duplicate-detection scheme;
 * a collision is simply re-rolled against the store.
 *
 * @param {string} claim
 * @returns {Promise<string>} pageId
 */
export async function createPageId(claim) {
  const readable = slugify(claim);
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(4).toString('hex');
    const pageId = `${readable}-${suffix}`;
    const { rows } = await query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
    if (rows.length === 0) return pageId;
  }
  // Astronomically unlikely fallback: a full UUID suffix instead of 8 hex chars.
  return `${readable}-${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * @param {string} pageId
 * @param {object} record - { pageId, claim, topic, createdAt, article, citations, images, counterarguments }
 */
export async function savePage(pageId, record) {
  await query(
    `INSERT INTO pages (id, claim, topic, article, citations, images, counterarguments, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))
     ON CONFLICT (id) DO UPDATE SET
       claim = EXCLUDED.claim,
       topic = EXCLUDED.topic,
       article = EXCLUDED.article,
       citations = EXCLUDED.citations,
       images = EXCLUDED.images,
       counterarguments = EXCLUDED.counterarguments`,
    [
      pageId,
      record.claim,
      record.topic ?? null,
      JSON.stringify(record.article ?? {}),
      JSON.stringify(record.citations ?? []),
      JSON.stringify(record.images ?? {}),
      record.counterarguments != null ? JSON.stringify(record.counterarguments) : null,
      record.createdAt ?? null,
    ]
  );
}

/**
 * @param {string} pageId
 * @returns {Promise<object|null>} - The stored record, or null if missing/invalid.
 */
export async function loadPage(pageId) {
  if (!isValidPageId(pageId)) return null;
  const { rows } = await query(
    'SELECT id, claim, topic, article, citations, images, counterarguments, created_at FROM pages WHERE id = $1',
    [pageId]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    pageId: row.id,
    claim: row.claim,
    topic: row.topic,
    article: row.article,
    citations: row.citations,
    images: row.images,
    counterarguments: row.counterarguments,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
