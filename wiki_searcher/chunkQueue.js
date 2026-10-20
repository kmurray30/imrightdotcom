/**
 * A shared work queue of snapshot chunks in Postgres, so any number of build
 * processes — on one machine or several, GPU or CPU — pull the next chunk as
 * they free up instead of each owning a fixed slice. Faster workers simply
 * do more chunks.
 *
 * A worker CLAIMS a chunk and keeps a lease on it by heartbeating (with how
 * far it has got, for the shared progress display). A worker that dies stops
 * heartbeating; once its lease runs out (CHUNK_LEASE_SEC, default 300) any
 * worker can claim the chunk and resume it — every article already stored
 * is skipped by the version check, so a reclaim only repeats the download.
 *
 * Connection failures are retried forever with capped backoff, the same
 * policy as the span writes (embeddingIndex.js).
 */
import os from 'node:os';
import { getPool } from '../imright/scripts/db.js';
import { isRetryableConnectionError } from './embeddingIndex.js';

export const QUEUE_TABLE = 'wiki_build_chunks';
const LEASE_SEC = Number(process.env.CHUNK_LEASE_SEC) || 300;
/** A chunk released this many times (each release = the build gave up on it after its own retries) is no longer handed out. */
export const MAX_CHUNK_ATTEMPTS = 6;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;

let warn = console.error;
/** Where queue connection warnings go (the build routes them through its progress table). */
export function setQueueWarningLogger(fn) {
  warn = fn;
}

export function makeWorkerId(device) {
  return `${os.hostname()}:${process.pid}:${device || 'cpu'}`;
}

async function query(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; the chunk queue needs the database.');
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      warn(`⚠ chunk queue: connection lost (attempt ${attempt}) — ${error.message}, retrying in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function ensureQueueTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${QUEUE_TABLE} (
      chunk_id     TEXT PRIMARY KEY,
      ord          INT NOT NULL,
      claimed_by   TEXT,
      claimed_at   TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      lines_done   INT NOT NULL DEFAULT 0,
      total_lines  INT,
      done_at      TIMESTAMPTZ,
      attempts     INT NOT NULL DEFAULT 0,
      last_error   TEXT
    )`);
}

/** Adds every snapshot chunk (in snapshot order); existing rows are left alone. */
export async function registerChunks(chunkIds) {
  if (chunkIds.length === 0) return;
  await query(
    `INSERT INTO ${QUEUE_TABLE} (chunk_id, ord) SELECT id, ord - 1 FROM unnest($1::text[]) WITH ORDINALITY AS t(id, ord)
     ON CONFLICT (chunk_id) DO NOTHING`,
    [chunkIds]
  );
}

/**
 * What this worker's state dir already knows: finished chunks are marked done
 * for everyone; chunks with work in progress on local disk (a checkpoint or an
 * extracted file) are claimed for this worker, so it resumes them instead of
 * another worker re-downloading them.
 * @param {Array<{chunkId: string, totalLines: number|null}>} doneChunks
 * @param {Array<{chunkId: string, linesDone: number}>} inProgressChunks
 */
export async function importLocalState(workerId, doneChunks, inProgressChunks) {
  if (doneChunks.length > 0) {
    await query(
      `UPDATE ${QUEUE_TABLE} q SET done_at = COALESCE(q.done_at, now()), total_lines = COALESCE(t.total, q.total_lines),
         lines_done = GREATEST(q.lines_done, COALESCE(t.total, q.lines_done)), claimed_by = NULL
       FROM unnest($1::text[], $2::int[]) AS t(id, total) WHERE q.chunk_id = t.id`,
      [doneChunks.map((c) => c.chunkId), doneChunks.map((c) => c.totalLines ?? null)]
    );
  }
  if (inProgressChunks.length > 0) {
    // Claimed only if nobody else holds a live lease on it.
    await query(
      `UPDATE ${QUEUE_TABLE} q SET claimed_by = $1, claimed_at = now(), heartbeat_at = now(), lines_done = GREATEST(q.lines_done, t.lines)
       FROM unnest($2::text[], $3::int[]) AS t(id, lines)
       WHERE q.chunk_id = t.id AND q.done_at IS NULL
         AND (q.claimed_by IS NULL OR q.claimed_by = $1 OR q.heartbeat_at < now() - make_interval(secs => $4))`,
      [workerId, inProgressChunks.map((c) => c.chunkId), inProgressChunks.map((c) => c.linesDone), LEASE_SEC]
    );
  }
}

/**
 * Claims the next chunk for this worker: first one it already holds but isn't
 * working on (`exclude` = chunks it has in hand), else the first unclaimed or
 * lease-expired one in snapshot order. Returns the chunk id, or null when
 * nothing is left to hand out.
 */
export async function claimNext(workerId, exclude = []) {
  const { rows } = await query(
    `UPDATE ${QUEUE_TABLE} SET claimed_by = $1, claimed_at = now(), heartbeat_at = now()
     WHERE chunk_id = (
       SELECT chunk_id FROM ${QUEUE_TABLE}
       WHERE done_at IS NULL AND attempts < $3 AND NOT (chunk_id = ANY($2::text[]))
         AND (claimed_by IS NULL OR claimed_by = $1 OR heartbeat_at < now() - make_interval(secs => $4))
       ORDER BY (claimed_by IS NOT DISTINCT FROM $1) DESC, ord
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING chunk_id`,
    [workerId, exclude, MAX_CHUNK_ATTEMPTS, LEASE_SEC]
  );
  return rows[0]?.chunk_id ?? null;
}

/** Renews this worker's lease on the chunks it holds and records how far each has got. */
export async function heartbeat(workerId, linesByChunk) {
  const ids = Object.keys(linesByChunk);
  if (ids.length === 0) return;
  await query(
    `UPDATE ${QUEUE_TABLE} q SET heartbeat_at = now(), lines_done = GREATEST(q.lines_done, t.lines)
     FROM unnest($2::text[], $3::int[]) AS t(id, lines)
     WHERE q.chunk_id = t.id AND q.claimed_by = $1 AND q.done_at IS NULL`,
    [workerId, ids, ids.map((id) => linesByChunk[id])]
  );
}

export async function markDone(chunkId, totalLines) {
  await query(
    `UPDATE ${QUEUE_TABLE} SET done_at = now(), total_lines = $2, lines_done = GREATEST(lines_done, COALESCE($2, lines_done)), claimed_by = NULL, last_error = NULL
     WHERE chunk_id = $1`,
    [chunkId, totalLines ?? null]
  );
}

/** Gives a chunk back after the build gave up on it: anyone may retry it later, up to MAX_CHUNK_ATTEMPTS releases. */
export async function release(chunkId, error) {
  await query(
    `UPDATE ${QUEUE_TABLE} SET claimed_by = NULL, heartbeat_at = NULL, attempts = attempts + 1, last_error = $2 WHERE chunk_id = $1`,
    [chunkId, String(error ?? '').slice(0, 2000)]
  );
}

/** Lets go of a chunk this worker claimed but never started (e.g. on shutdown), without counting an attempt. */
export async function unclaim(workerId, chunkId) {
  await query(`UPDATE ${QUEUE_TABLE} SET claimed_by = NULL, heartbeat_at = NULL WHERE chunk_id = $1 AND claimed_by = $2 AND done_at IS NULL`, [chunkId, workerId]);
}

/**
 * Corpus-wide progress for the display, the same for every worker.
 * @returns {{ chunks: number, doneChunks: number, linesDone: number, liveWorkers: string[], stuck: Array<{chunkId: string, attempts: number, lastError: string}> }}
 */
export async function queueSnapshot() {
  const { rows: [totals] } = await query(
    `SELECT count(*)::int AS chunks, count(done_at)::int AS done_chunks,
            COALESCE(sum(CASE WHEN done_at IS NOT NULL THEN COALESCE(total_lines, lines_done) ELSE lines_done END), 0)::bigint AS lines_done
     FROM ${QUEUE_TABLE}`
  );
  const { rows: workers } = await query(
    `SELECT DISTINCT claimed_by FROM ${QUEUE_TABLE} WHERE claimed_by IS NOT NULL AND done_at IS NULL AND heartbeat_at > now() - interval '90 seconds'`
  );
  const { rows: stuck } = await query(
    `SELECT chunk_id, attempts, last_error FROM ${QUEUE_TABLE} WHERE done_at IS NULL AND attempts >= $1 ORDER BY ord`,
    [MAX_CHUNK_ATTEMPTS]
  );
  return {
    chunks: totals.chunks,
    doneChunks: totals.done_chunks,
    linesDone: Number(totals.lines_done),
    liveWorkers: workers.map((w) => w.claimed_by),
    stuck: stuck.map((s) => ({ chunkId: s.chunk_id, attempts: s.attempts, lastError: s.last_error })),
  };
}

/**
 * Chunks still to do that are NOT in `exclude` and not given up on for good:
 * claimable now, or held by another worker (whose lease may yet expire).
 */
export async function pendingCount(exclude = []) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM ${QUEUE_TABLE} WHERE done_at IS NULL AND attempts < $2 AND NOT (chunk_id = ANY($1::text[]))`,
    [exclude, MAX_CHUNK_ATTEMPTS]
  );
  return rows[0].n;
}

/**
 * The slot loop: `slots` concurrent workers, each holding a current chunk and
 * one prefetched chunk (claimed, its preparation already started).
 *
 * Claims are serialized within the process, so every claim sees the chunks
 * this process already holds (`exclude`) — concurrent claims would otherwise
 * all be handed the same chunk this worker already owns. When nothing is
 * claimable, a slot does not exit while other workers still hold unfinished
 * chunks (`remaining` > 0): it polls every `pollMs`, so a dead worker's chunks
 * are picked up once its lease expires. `processChunk` should not throw (the
 * build handles its own retries); a throw is reported via `onError`.
 *
 * @param {object} o
 * @param {number} o.slots
 * @param {(exclude: string[]) => Promise<string|null>} o.claim
 * @param {(chunkId: string) => void} o.prefetch - start preparing (download/extract) a chunk in the background
 * @param {(chunkId: string) => Promise<void>} o.processChunk
 * @param {(exclude: string[]) => Promise<number>} [o.remaining] - unfinished chunks outside `exclude`; omit to exit as soon as nothing is claimable
 * @param {number} [o.pollMs]
 * @param {(error: Error, chunkId: string) => void} [o.onError]
 */
export async function runQueue({ slots, claim, prefetch, processChunk, remaining = null, pollMs = 15_000, onError = () => {} }) {
  const inHand = new Set(); // claimed by this process and not finished
  let chain = Promise.resolve();
  function claimOne() {
    const result = chain.then(async () => {
      const id = await claim([...inHand]);
      if (id !== null) inHand.add(id);
      return id;
    });
    chain = result.catch(() => {});
    return result;
  }
  async function slot() {
    for (;;) {
      let current = await claimOne();
      if (current === null) {
        if (!remaining || (await remaining([...inHand])) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      while (current !== null) {
        const next = await claimOne();
        if (next !== null) prefetch(next);
        try {
          await processChunk(current);
        } catch (error) {
          onError(error, current);
        }
        inHand.delete(current);
        current = next;
      }
    }
  }
  await Promise.all(Array.from({ length: slots }, slot));
}
