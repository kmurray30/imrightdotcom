/**
 * Drizzle instance wrapping the existing shared `pg` Pool (imright/scripts/db.js)
 * rather than opening a second connection pool — site_lock/backup_links's raw
 * `pg` queries and these Drizzle-based queries share one pool.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { getPool } from '../db.js';
import * as schema from './schema.js';

let dbInstance = null;

/** Returns the shared Drizzle instance, or null if DATABASE_URL isn't configured. */
export function getDb() {
  const pool = getPool();
  if (!pool) return null;
  if (!dbInstance) {
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export { schema };
