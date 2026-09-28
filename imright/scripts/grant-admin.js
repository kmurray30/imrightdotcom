#!/usr/bin/env node
/**
 * One-off CLI to flip a real account's users.is_admin to true (or false with
 * --revoke), so it can view GET /api/articles/:id/debug for any article. No
 * self-serve signup path grants this on purpose — it's a support/dev tool,
 * not a social-layer permission, so it's set directly against the DB.
 *
 * Usage: node imright/scripts/grant-admin.js <username>
 *   or:  node imright/scripts/grant-admin.js <username> --revoke
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { loadEnv } from '../load-env.js';

loadEnv();

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--revoke');
  const revoke = process.argv.includes('--revoke');
  const username = args[0]?.trim();
  if (!username) {
    console.error('Usage: node imright/scripts/grant-admin.js <username> [--revoke]');
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }

  const [row] = await db
    .update(schema.users)
    .set({ isAdmin: !revoke })
    .where(eq(schema.users.username, username))
    .returning({ id: schema.users.id, username: schema.users.username, isAdmin: schema.users.isAdmin });

  if (!row) {
    console.error(`No account found with username "${username}".`);
    process.exit(1);
  }

  console.log(`${row.username} (${row.id}): is_admin = ${row.isAdmin}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
