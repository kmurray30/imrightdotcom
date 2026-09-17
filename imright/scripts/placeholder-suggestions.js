/**
 * Persists the pool of example beliefs the landing page's animated
 * placeholder cycles through, in Postgres (see db.js) — editable from
 * /admin instead of a config file, so new ideas can be added on the fly
 * with no deploy. Same "survive restarts and redeploys" reasoning as
 * site-lock.js.
 *
 * Seeded once, the first time the table is found empty, from the list that
 * used to live in config/placeholder_suggestions.txt (and, before that, a
 * hard-coded array in index.html) — see SEED_SUGGESTIONS below. That file
 * is no longer read by anything after this change.
 */

import { getPool } from './db.js';

const SEED_SUGGESTIONS = [
  "EV's destroy the grid",
  'Squirrels are russian spies',
  'Pigeons recharge on power lines',
  'Eating poo is good for you',
  'Wifi can control your thoughts',
  'LEDs cause skin cancer',
  '5G towers control the weather',
  "children's cereal contains addictive drugs",
  'AC companies are causing global warming',
  'Cats secretly understand english',
  'Mosquitoes are government blood collectors',
  'Autocorrect intentionally causes drama',
  'Costco loses money on hot dogs to collect DNA',
  'We have a finite number of heartbeats',
];

let ensureTablePromise = null;

async function seedIfEmpty(pool) {
  const { rows } = await pool.query('SELECT 1 FROM placeholder_suggestions LIMIT 1');
  if (rows.length > 0) return;
  for (const text of SEED_SUGGESTIONS) {
    await pool.query('INSERT INTO placeholder_suggestions (text) VALUES ($1)', [text]);
  }
}

function ensureTable() {
  const pool = getPool();
  if (!pool) return Promise.resolve(false);
  if (!ensureTablePromise) {
    ensureTablePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS placeholder_suggestions (
           id SERIAL PRIMARY KEY,
           text TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .then(() => seedIfEmpty(pool))
      .then(() => true)
      .catch((error) => {
        ensureTablePromise = null;
        throw error;
      });
  }
  return ensureTablePromise;
}

/** Public: just the text values, for the animated placeholder to cycle
 * through. Falls back to the seed list if the DB is unreachable or
 * unconfigured, so the animation still has something to show. */
export async function listPlaceholderSuggestionTexts() {
  const pool = getPool();
  if (!pool) return [...SEED_SUGGESTIONS];
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT text FROM placeholder_suggestions ORDER BY created_at ASC, id ASC');
    return rows.map((row) => row.text);
  } catch (error) {
    console.error('[placeholder-suggestions] list failed, falling back to seed list:', error?.message ?? error);
    return [...SEED_SUGGESTIONS];
  }
}

/** Admin: full rows (id + text) so the dashboard can edit/delete individual entries. */
export async function listPlaceholderSuggestions() {
  const pool = getPool();
  if (!pool) return [];
  await ensureTable();
  const { rows } = await pool.query('SELECT id, text FROM placeholder_suggestions ORDER BY created_at ASC, id ASC');
  return rows;
}

export async function addPlaceholderSuggestion(text) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set');
  await ensureTable();
  const { rows } = await pool.query(
    'INSERT INTO placeholder_suggestions (text) VALUES ($1) RETURNING id, text',
    [text]
  );
  return rows[0];
}

export async function updatePlaceholderSuggestion(id, text) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set');
  await ensureTable();
  const { rows } = await pool.query(
    'UPDATE placeholder_suggestions SET text = $1 WHERE id = $2 RETURNING id, text',
    [text, id]
  );
  return rows[0] ?? null;
}

export async function deletePlaceholderSuggestion(id) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set');
  await ensureTable();
  const { rowCount } = await pool.query('DELETE FROM placeholder_suggestions WHERE id = $1', [id]);
  return rowCount > 0;
}
