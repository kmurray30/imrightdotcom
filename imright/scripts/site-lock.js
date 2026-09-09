/**
 * Persists whether the main site's password gate is on/off and the hash of
 * the current site password, in Postgres (see db.js) — not a file or
 * in-memory state, so it survives restarts *and* redeploys. Read fresh on
 * every request (same "no restart needed" spirit as config/app_config.json
 * elsewhere in serve-site.js) so a change made from /admin takes effect
 * immediately.
 */

import { getPool } from './db.js';

// No password configured yet: the site starts open rather than locked with
// no working password, until an admin sets one from /admin.
const DEFAULT_STATE = { passwordProtectionEnabled: false, passwordHash: null };

let ensureTablePromise = null;

function ensureTable() {
  const pool = getPool();
  if (!pool) return Promise.resolve(false);
  if (!ensureTablePromise) {
    ensureTablePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS site_lock (
           id INTEGER PRIMARY KEY DEFAULT 1,
           password_protection_enabled BOOLEAN NOT NULL DEFAULT false,
           password_hash TEXT,
           CONSTRAINT site_lock_singleton CHECK (id = 1)
         )`
      )
      .then(() => true)
      .catch((error) => {
        ensureTablePromise = null;
        throw error;
      });
  }
  return ensureTablePromise;
}

export async function readSiteLock() {
  const pool = getPool();
  if (!pool) return { ...DEFAULT_STATE };
  try {
    await ensureTable();
    const { rows } = await pool.query(
      'SELECT password_protection_enabled, password_hash FROM site_lock WHERE id = 1'
    );
    if (rows.length === 0) return { ...DEFAULT_STATE };
    return {
      passwordProtectionEnabled: Boolean(rows[0].password_protection_enabled),
      passwordHash: rows[0].password_hash ?? null,
    };
  } catch (error) {
    console.error('[site-lock] read failed, falling back to default state:', error?.message ?? error);
    return { ...DEFAULT_STATE };
  }
}

export async function writeSiteLock(patch) {
  const pool = getPool();
  if (!pool) {
    console.error('[site-lock] write skipped: DATABASE_URL is not set, nothing to persist to.');
    return { ...DEFAULT_STATE, ...patch };
  }
  await ensureTable();
  const current = await readSiteLock();
  const next = { ...current, ...patch };
  await pool.query(
    `INSERT INTO site_lock (id, password_protection_enabled, password_hash)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET
       password_protection_enabled = EXCLUDED.password_protection_enabled,
       password_hash = EXCLUDED.password_hash`,
    [next.passwordProtectionEnabled, next.passwordHash]
  );
  return next;
}
