/**
 * Postgres connection pool, shared by page-store.js (and anything else that
 * needs the DB). Reads DATABASE_URL — the env var Railway injects
 * automatically once a Postgres service is attached to this project (see
 * imright/scripts/schema.sql for setup instructions).
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Attach a Postgres service on Railway (or set DATABASE_URL in env.local for local dev) — see imright/scripts/schema.sql.'
    );
  }

  // Railway's internal DB connection (the one this server uses in production,
  // over Railway's private network) does not use TLS. Only the public proxy
  // connection (e.g. connecting from your laptop to run a migration) needs
  // it — set PGSSL=require in that shell for that one-off command.
  const sslMode = (process.env.PGSSL || '').toLowerCase();
  const ssl = sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : false;

  pool = new Pool({ connectionString, ssl });
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * @param {string} text - SQL, with $1/$2/... placeholders
 * @param {Array} [params]
 */
export function query(text, params) {
  return getPool().query(text, params);
}
