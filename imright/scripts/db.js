/**
 * Shared Postgres connection pool, built from DATABASE_URL. Railway injects
 * this automatically once a Postgres database is attached to the project
 * (New -> Database -> PostgreSQL); for local dev, point it at any Postgres
 * instance (see README).
 *
 * A real DB (rather than a JSON file or in-memory state) is what makes
 * site-lock.js's state survive redeploys: Railway's app filesystem is not
 * guaranteed to persist across deploys, but its managed Postgres is a
 * separate, persistent service.
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;
let warnedMissingUrl = false;

function shouldUseSsl(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
    if (hostname.endsWith('.railway.internal')) return false;
    return true;
  } catch {
    return true;
  }
}

/** Returns the shared pool, or null if DATABASE_URL isn't configured. */
export function getPool() {
  const connectionString = process.env.DATABASE_URL || '';
  if (!connectionString) {
    if (!warnedMissingUrl) {
      console.error('[db] DATABASE_URL is not set; database-backed features are unavailable.');
      warnedMissingUrl = true;
    }
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
      max: 5,
    });
    pool.on('error', (poolError) => {
      // Idle client errors (e.g. a dropped connection) shouldn't crash the process.
      console.error('[db] idle client error:', poolError?.message ?? poolError);
    });
  }
  return pool;
}
