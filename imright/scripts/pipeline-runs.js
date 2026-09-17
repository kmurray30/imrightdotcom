/**
 * Durable status for a POST /api/run execution — see schema.js's docstring
 * on pipelineRuns for why this exists (recovering GET /api/stream/:runId
 * from a cross-process reconnect after a deploy/crash, instead of a bare
 * 404 that the client retries forever).
 */

import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';

export async function createPipelineRun({ id, ownerUserId }) {
  const db = getDb();
  await db.insert(schema.pipelineRuns).values({ id, ownerUserId, status: 'running' });
}

export async function markPipelineRunReady({ id, articleId }) {
  const db = getDb();
  await db
    .update(schema.pipelineRuns)
    .set({ status: 'ready', articleId, updatedAt: new Date() })
    .where(eq(schema.pipelineRuns.id, id));
}

export async function markPipelineRunDone(id) {
  const db = getDb();
  await db
    .update(schema.pipelineRuns)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(schema.pipelineRuns.id, id));
}

export async function markPipelineRunError({ id, errorMessage }) {
  const db = getDb();
  await db
    .update(schema.pipelineRuns)
    .set({ status: 'error', errorMessage, updatedAt: new Date() })
    .where(eq(schema.pipelineRuns.id, id));
}

export async function getPipelineRun(id) {
  const db = getDb();
  const [row] = await db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, id)).limit(1);
  return row ?? null;
}
