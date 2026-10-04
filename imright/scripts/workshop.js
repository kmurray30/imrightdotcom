/**
 * DB access for Workshop experiments — one module per concern, same pattern
 * as articles.js/feedback.js.
 */

import { eq, desc } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createRun({ createdByUserId, sourceArticleId, claimText, startStage, stageConfig }) {
  const db = getDb();
  const [row] = await db
    .insert(schema.workshopRuns)
    .values({ createdByUserId, sourceArticleId: sourceArticleId ?? null, claimText, startStage, stageConfig })
    .returning();
  return row;
}

export async function getRun(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const db = getDb();
  const [row] = await db.select().from(schema.workshopRuns).where(eq(schema.workshopRuns.id, id)).limit(1);
  return row ?? null;
}

export async function listRuns({ cursor = 0, limit = 50 } = {}) {
  const db = getDb();
  return db
    .select({
      id: schema.workshopRuns.id,
      createdByUserId: schema.workshopRuns.createdByUserId,
      sourceArticleId: schema.workshopRuns.sourceArticleId,
      claimText: schema.workshopRuns.claimText,
      startStage: schema.workshopRuns.startStage,
      status: schema.workshopRuns.status,
      errorMessage: schema.workshopRuns.errorMessage,
      createdAt: schema.workshopRuns.createdAt,
    })
    .from(schema.workshopRuns)
    .orderBy(desc(schema.workshopRuns.createdAt))
    .limit(limit)
    .offset(cursor);
}

export async function completeRun(id, resultData) {
  const db = getDb();
  await db
    .update(schema.workshopRuns)
    .set({ status: 'done', resultData, updatedAt: new Date() })
    .where(eq(schema.workshopRuns.id, id));
}

export async function failRun(id, errorMessage) {
  const db = getDb();
  await db
    .update(schema.workshopRuns)
    .set({ status: 'error', errorMessage, updatedAt: new Date() })
    .where(eq(schema.workshopRuns.id, id));
}

/** Debug-style rendering reads just this column — kept separate from getRun
 * so the (potentially large) result_data blob isn't fetched by routes that
 * only need run status (e.g. polling). */
export async function getDebugDataForRun(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const db = getDb();
  const [row] = await db
    .select({ resultData: schema.workshopRuns.resultData })
    .from(schema.workshopRuns)
    .where(eq(schema.workshopRuns.id, id))
    .limit(1);
  return row?.resultData ?? null;
}

export async function getKnownModels(provider) {
  const db = getDb();
  const rows = await db
    .select({ modelName: schema.workshopKnownModels.modelName })
    .from(schema.workshopKnownModels)
    .where(eq(schema.workshopKnownModels.provider, provider));
  return rows.map((r) => r.modelName);
}

export async function rememberKnownModel(provider, modelName) {
  const db = getDb();
  await db.insert(schema.workshopKnownModels).values({ provider, modelName }).onConflictDoNothing();
}
