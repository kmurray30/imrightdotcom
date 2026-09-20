/**
 * Durable status for a POST /api/run execution — see schema.js's docstring
 * on pipelineRuns for why this exists (recovering GET /api/stream/:runId
 * from a cross-process reconnect after a deploy/crash, instead of a bare
 * 404 that the client retries forever, or leaving the user with nothing
 * more than an error message when the interruption is recoverable).
 */

import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';

// Total attempts for a run that keeps getting interrupted (by deploys,
// crashes) is this + 1 (the original). Bounded so a claim that fails
// deterministically — not from interruption — can't retry forever and rack
// up real LLM cost; genuine pipeline failures short-circuit before ever
// reaching a retry decision (see claimPipelineRunRetry's WHERE clause).
export const MAX_PIPELINE_RUN_RETRIES = 2;

export async function createPipelineRun({ id, ownerUserId, claimText }) {
  const db = getDb();
  await db.insert(schema.pipelineRuns).values({ id, ownerUserId, claimText, status: 'running' });
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

/**
 * Atomically claims the right to auto-retry an orphaned run — status is
 * still 'running' with nobody's in-memory activeRuns owning it, meaning the
 * process that did died mid-run. A single UPDATE...WHERE...RETURNING so
 * that if several reconnects land at once (multiple tabs, the browser's own
 * EventSource retry racing a manual refresh), only one of them actually
 * gets a row back and restarts the pipeline; the rest see status flip out
 * from under their WHERE clause and get nothing. Returns null when there's
 * nothing to claim: retries already exhausted, or someone else just claimed
 * this attempt.
 */
export async function claimPipelineRunRetry(id, { maxRetries = MAX_PIPELINE_RUN_RETRIES } = {}) {
  const db = getDb();
  const result = await db.execute(sql`
    UPDATE pipeline_runs
    SET retry_count = retry_count + 1, updated_at = now()
    WHERE id = ${id} AND status = 'running' AND retry_count < ${maxRetries}
    RETURNING id, owner_user_id AS "ownerUserId", claim_text AS "claimText", retry_count AS "retryCount"
  `);
  return result.rows[0] ?? null;
}
