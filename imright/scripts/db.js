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

export function shouldUseSsl(connectionString) {
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
      // 20: one pipeline run fires ~10–16 vector searches at once (see
      // wiki_searcher/spanSearch.js), and concurrent runs share
      // this pool; Postgres allows 100 connections. Overridable per-process
      // via DB_POOL_MAX (e.g. by the bulk embedding build) without changing
      // the default every other process — including the deployed server —
      // gets when unset.
      max: Number(process.env.DB_POOL_MAX) || 20,
      // Without these, a connection that goes half-open (e.g. an SSH tunnel
      // whose process died but whose local socket hasn't noticed yet) hangs
      // a query forever with no error and no output — indistinguishable from
      // the process just being slow. Bounding both means a dead tunnel fails
      // loudly within seconds instead of silently stalling a multi-hour job.
      connectionTimeoutMillis: 10_000,
      // How long an unused connection stays open. pg's default (10 s) means a
      // process with bursty queries reconnects constantly; over a remote
      // endpoint each reconnect is a TCP + TLS handshake, and a share of
      // them time out (seen as ETIMEDOUT from the bulk build). Long-running
      // jobs set DB_IDLE_TIMEOUT_MS higher (0 = never close idle ones).
      idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT_MS !== undefined ? Number(process.env.DB_IDLE_TIMEOUT_MS) : 10_000,
      // TCP keepalive, so routers and proxies don't silently drop idle connections we keep.
      keepAlive: true,
      // Idle connections don't keep the process alive (a finished script still exits).
      allowExitOnIdle: true,
      // DB_STATEMENT_TIMEOUT_MS overrides it per-process (0 = none), e.g. for
      // wiki_searcher/scripts/check-span-search.js's exact scans, which take
      // minutes.
      statement_timeout: process.env.DB_STATEMENT_TIMEOUT_MS !== undefined ? Number(process.env.DB_STATEMENT_TIMEOUT_MS) : 30_000,
    });
    pool.on('error', (poolError) => {
      // Idle client errors (e.g. a dropped connection) shouldn't crash the process.
      console.error('[db] idle client error:', poolError?.message ?? poolError);
    });
  }
  return pool;
}
