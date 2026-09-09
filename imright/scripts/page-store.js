/**
 * Persists generated pages forever (as far as the filesystem allows) so a
 * link to a page keeps working without re-running the pipeline. Each page
 * is a small JSON record — article text, citations, and hotlinked image
 * URLs, no binary assets — written to data/pages/<pageId>.json.
 *
 * Note: on Railway without a persistent volume mounted at the project's
 * `data/` directory, this resets on every redeploy — same caveat as
 * site-lock.js. Attach a volume there for pages to actually survive deploys.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { slugify } from '../utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PAGES_DIR = path.join(PROJECT_ROOT, 'data', 'pages');

const PAGE_ID_PATTERN = /^[a-z0-9-]+$/;

function pagePath(pageId) {
  return path.join(PAGES_DIR, `${pageId}.json`);
}

/**
 * Mint a page id: `<readable-slug>-<8 hex chars>`. The hex suffix is what
 * guarantees uniqueness — two people generating the same claim just get
 * different suffixes — so there's no separate duplicate-detection scheme;
 * a collision is simply re-rolled against the store.
 *
 * @param {string} claim
 * @returns {string} pageId
 */
export function createPageId(claim) {
  const readable = slugify(claim);
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(4).toString('hex');
    const pageId = `${readable}-${suffix}`;
    if (!fs.existsSync(pagePath(pageId))) return pageId;
  }
  // Astronomically unlikely fallback: a full UUID suffix instead of 8 hex chars.
  return `${readable}-${crypto.randomUUID().replace(/-/g, '')}`;
}

/** @param {string} pageId */
export function isValidPageId(pageId) {
  return typeof pageId === 'string' && pageId.length > 0 && pageId.length <= 200 && PAGE_ID_PATTERN.test(pageId);
}

/**
 * @param {string} pageId
 * @param {object} record
 */
export function savePage(pageId, record) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  fs.writeFileSync(pagePath(pageId), JSON.stringify(record, null, 2), 'utf8');
}

/**
 * @param {string} pageId
 * @returns {object|null} - The stored record, or null if missing/invalid.
 */
export function loadPage(pageId) {
  if (!isValidPageId(pageId)) return null;
  try {
    return JSON.parse(fs.readFileSync(pagePath(pageId), 'utf8'));
  } catch {
    return null;
  }
}
