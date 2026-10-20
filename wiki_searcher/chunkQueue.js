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
import { isRetryableConnectionError, withSchemaLock, describeError } from './embeddingIndex.js';

export const QUEUE_TABLE = 'wiki_build_chunks';
/** One row about every minute (whichever worker gets there first): the queue's total lines done. Shared rate, ETA and elapsed come from this. */
export const PROGRESS_TABLE = 'wiki_build_progress';
const META_TABLE = 'wiki_build_meta';
const RATE_WINDOW_SEC = 180; // Art/s: recent combined rate
const ETA_WINDOW_SEC = 20 * 60; // ETA: steadier combined rate
const ACTIVE_GAP_MAX_SEC = 180; // a longer gap between samples (nobody running, or no progress) is not counted as build time
const LEASE_SEC = Number(process.env.CHUNK_LEASE_SEC) || 300;
/** A chunk released this many times (each release = the build gave up on it after its own retries) is no longer handed out. */
export const MAX_CHUNK_ATTEMPTS = 6;
const RETRY_BASE_MS = 2000;
// Identifies the code that decided to give up on a chunk: a chunk given up
// on by older code (possibly a bug since fixed) is handed out again to
// newer code, however many attempts it already has.
let codeVersion = 'unknown';
export function setCodeVersion(version) {
  codeVersion = version;
}
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
      warn(`⚠ chunk queue: connection lost (attempt ${attempt}) — ${describeError(error)}, retrying in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function ensureQueueTable() {
  await withSchemaLock(async (client) => {
    await client.query(`
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
    await client.query(`ALTER TABLE ${QUEUE_TABLE} ADD COLUMN IF NOT EXISTS failed_version TEXT`);
    // Bundle mode (fetch-snapshot-bundle.js): where the chunk's NDJSON was staged on local disk.
    await client.query(`ALTER TABLE ${QUEUE_TABLE} ADD COLUMN IF NOT EXISTS staged_path TEXT`);
    await client.query(`ALTER TABLE ${QUEUE_TABLE} ADD COLUMN IF NOT EXISTS staged_at TIMESTAMPTZ`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (taken_at TIMESTAMPTZ PRIMARY KEY DEFAULT clock_timestamp(), lines_done BIGINT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
  });
}

const LINES_DONE_SQL = `SELECT COALESCE(sum(CASE WHEN done_at IS NOT NULL THEN COALESCE(total_lines, lines_done) ELSE lines_done END), 0) FROM ${QUEUE_TABLE}`;

/** Adds a progress sample unless one was taken in the last 55 s. Cheap; every worker calls it on its refresh tick. */
export async function recordProgressSample() {
  await query(
    `INSERT INTO ${PROGRESS_TABLE} (taken_at, lines_done)
     SELECT clock_timestamp(), (${LINES_DONE_SQL})
     WHERE NOT EXISTS (SELECT 1 FROM ${PROGRESS_TABLE} WHERE taken_at > clock_timestamp() - interval '55 seconds')
     ON CONFLICT (taken_at) DO NOTHING`
  );
}

/** Sets the build time accumulated before the shared history existed. First caller wins. */
export async function seedActiveMs(ms) {
  if (!(ms > 0)) return;
  await query(`INSERT INTO ${META_TABLE} (key, value) VALUES ('active_ms_seed', to_jsonb($1::bigint)) ON CONFLICT (key) DO NOTHING`, [Math.round(ms)]);
}

/**
 * Whole-build rate and elapsed time from the shared history, computed with
 * the database's clock so every worker on every machine gets the same
 * numbers. rate/etaRate are null until the history spans a minute.
 * @returns {Promise<{ rate: number|null, etaRate: number|null, activeMs: number }>}
 */
export async function progressStats() {
  const { rows: [row] } = await query(
    `WITH s AS (
       SELECT taken_at, lines_done,
              lag(taken_at) OVER (ORDER BY taken_at) AS prev_at,
              lag(lines_done) OVER (ORDER BY taken_at) AS prev_lines
       FROM ${PROGRESS_TABLE}
     ),
     latest AS (SELECT taken_at, lines_done, prev_at, prev_lines FROM s ORDER BY taken_at DESC LIMIT 1),
     win AS (
       SELECT
         (SELECT min(taken_at) FROM s WHERE taken_at >= (SELECT taken_at FROM latest) - make_interval(secs => $1)) AS r_from,
         (SELECT min(taken_at) FROM s WHERE taken_at >= (SELECT taken_at FROM latest) - make_interval(secs => $2)) AS e_from
     )
     SELECT
       (SELECT taken_at FROM latest) AS latest_at,
       (SELECT lines_done FROM latest) AS latest_lines,
       (SELECT lines_done FROM s WHERE taken_at = (SELECT r_from FROM win)) AS r_lines,
       extract(epoch FROM (SELECT taken_at FROM latest) - (SELECT r_from FROM win)) AS r_span,
       (SELECT lines_done FROM s WHERE taken_at = (SELECT e_from FROM win)) AS e_lines,
       extract(epoch FROM (SELECT taken_at FROM latest) - (SELECT e_from FROM win)) AS e_span,
       COALESCE((SELECT sum(extract(epoch FROM taken_at - prev_at)) FROM s
                 WHERE prev_at IS NOT NULL AND lines_done > prev_lines AND taken_at - prev_at <= make_interval(secs => $3)), 0) AS active_sec,
       (SELECT CASE WHEN l.prev_at IS NOT NULL AND l.lines_done > l.prev_lines AND clock_timestamp() - l.taken_at <= make_interval(secs => $3)
                    THEN extract(epoch FROM clock_timestamp() - l.taken_at) ELSE 0 END FROM latest l) AS tail_sec,
       COALESCE((SELECT (value #>> '{}')::bigint FROM ${META_TABLE} WHERE key = 'active_ms_seed'), 0) AS seed_ms`,
    [RATE_WINDOW_SEC, ETA_WINDOW_SEC, ACTIVE_GAP_MAX_SEC]
  );
  const rateOf = (lines, span) => (span >= 60 ? (Number(row.latest_lines) - Number(lines)) / span : null);
  return {
    rate: row.latest_at ? rateOf(row.r_lines, Number(row.r_span)) : null,
    etaRate: row.latest_at ? rateOf(row.e_lines, Number(row.e_span)) : null,
    activeMs: Number(row.seed_ms) + (Number(row.active_sec) + Number(row.tail_sec || 0)) * 1000,
  };
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
 * Chunks in progress in a SIBLING state dir (another local worker's) are
 * reserved under that worker's prefix (`host:dir:reserved`): when that worker
 * starts it adopts them (see the build's adoptPreviousClaims); if it never
 * does, the lease runs out and anyone takes them.
 * @param {Array<{chunkId: string, totalLines: number|null}>} doneChunks
 * @param {Array<{chunkId: string, linesDone: number}>} inProgressChunks
 * @param {Array<{chunkId: string, linesDone: number, owner: string}>} [reservedChunks]
 */
export async function importLocalState(workerId, doneChunks, inProgressChunks, reservedChunks = []) {
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
  if (reservedChunks.length > 0) {
    await query(
      `UPDATE ${QUEUE_TABLE} q SET claimed_by = t.owner, claimed_at = now(), heartbeat_at = now(), lines_done = GREATEST(q.lines_done, t.lines)
       FROM unnest($1::text[], $2::int[], $3::text[]) AS t(id, lines, owner)
       WHERE q.chunk_id = t.id AND q.done_at IS NULL
         AND (q.claimed_by IS NULL OR q.heartbeat_at < now() - make_interval(secs => $4))`,
      [reservedChunks.map((c) => c.chunkId), reservedChunks.map((c) => c.linesDone), reservedChunks.map((c) => c.owner), LEASE_SEC]
    );
  }
}

/** Bundle mode: the NDJSON for a chunk is on disk at `stagedPath`, ready for any worker to take. */
export async function stageChunk(chunkId, stagedPath) {
  await query(`UPDATE ${QUEUE_TABLE} SET staged_path = $2, staged_at = now() WHERE chunk_id = $1 AND done_at IS NULL`, [chunkId, stagedPath]);
}

/** Bundle mode, when bundle members can't be mapped to snapshot chunks: adds a member as its own unit of work, staged. */
export async function addStagedUnit(chunkId, stagedPath) {
  await query(
    `INSERT INTO ${QUEUE_TABLE} (chunk_id, ord, staged_path, staged_at)
     VALUES ($1, (SELECT COALESCE(max(ord), 0) + 1 FROM ${QUEUE_TABLE}), $2, now())
     ON CONFLICT (chunk_id) DO UPDATE SET staged_path = EXCLUDED.staged_path, staged_at = now() WHERE ${QUEUE_TABLE}.done_at IS NULL`,
    [chunkId, stagedPath]
  );
}

/**
 * Bundle mode, when members don't map to snapshot chunks: the snapshot's
 * own chunk rows that nobody holds and nothing staged are retired (their
 * articles arrive as bundle units instead), so workers don't wait on them.
 * Their lines are zeroed so progress isn't counted twice. Returns how many.
 */
export async function supersedeUnstagedChunks(prefix) {
  const { rowCount } = await query(
    `UPDATE ${QUEUE_TABLE} SET done_at = now(), lines_done = 0, total_lines = 0, last_error = 'superseded: its articles come from bundle units'
     WHERE chunk_id LIKE $1 AND done_at IS NULL AND staged_path IS NULL
       AND (claimed_by IS NULL OR heartbeat_at < now() - make_interval(secs => $2))`,
    [`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, LEASE_SEC]
  );
  return rowCount;
}

/** The bundle fetcher reports it is still reading ('running') or finished ('done' / 'stopped'). */
export async function setBundleFetcherState(state) {
  await query(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ('bundle_fetcher', jsonb_build_object('state', $1::text, 'at', now()))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [state]
  );
}

/** True while a bundle fetcher is reading (heartbeat within 2 minutes): more units may still arrive. */
export async function bundleFetcherActive() {
  const { rows } = await query(
    `SELECT 1 FROM ${META_TABLE} WHERE key = 'bundle_fetcher' AND value->>'state' = 'running' AND (value->>'at')::timestamptz > now() - interval '2 minutes'`
  );
  return rows.length > 0;
}

/** One chunk's queue row (or null). */
export async function chunkRow(chunkId) {
  const { rows } = await query(`SELECT chunk_id, done_at, total_lines, staged_path, claimed_by FROM ${QUEUE_TABLE} WHERE chunk_id = $1`, [chunkId]);
  return rows[0] ?? null;
}

/** Releases this worker's claim on a chunk it can't work on yet (bundle mode: waiting for the bundle), without counting an attempt. */
export async function unclaimMine(workerId, chunkIds) {
  if (chunkIds.length === 0) return;
  await query(`UPDATE ${QUEUE_TABLE} SET claimed_by = NULL, heartbeat_at = NULL WHERE claimed_by = $1 AND chunk_id = ANY($2::text[]) AND done_at IS NULL`, [workerId, chunkIds]);
}

/** Ids of chunks the queue marks done (for cleaning up local leftovers). */
export async function doneChunkIds() {
  const { rows } = await query(`SELECT chunk_id FROM ${QUEUE_TABLE} WHERE done_at IS NOT NULL`);
  return new Set(rows.map((r) => r.chunk_id));
}

/**
 * Claims the next chunk for this worker: first one it already holds but isn't
 * working on (`exclude` = chunks it has in hand), else the first unclaimed or
 * lease-expired one in snapshot order. Returns the chunk id, or null when
 * nothing is left to hand out.
 */
/**
 * @param {string} workerId
 * @param {string[]} [exclude]
 * @param {{ stagedOnly?: boolean }} [options] - bundle mode: only chunks the bundle fetcher has staged on disk (or that this worker already holds)
 */
export async function claimNext(workerId, exclude = [], { stagedOnly = false } = {}) {
  const { rows } = await query(
    `UPDATE ${QUEUE_TABLE} SET claimed_by = $1, claimed_at = now(), heartbeat_at = now()
     WHERE chunk_id = (
       SELECT chunk_id FROM ${QUEUE_TABLE}
       WHERE done_at IS NULL AND (attempts < $3 OR failed_version IS DISTINCT FROM $5) AND NOT (chunk_id = ANY($2::text[]))
         AND (claimed_by IS NULL OR claimed_by = $1 OR heartbeat_at < now() - make_interval(secs => $4))
         AND (NOT $6 OR staged_path IS NOT NULL OR claimed_by = $1)
       ORDER BY (claimed_by IS NOT DISTINCT FROM $1) DESC, ord
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING chunk_id`,
    [workerId, exclude, MAX_CHUNK_ATTEMPTS, LEASE_SEC, codeVersion, stagedOnly]
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
    `UPDATE ${QUEUE_TABLE} SET done_at = now(), total_lines = $2, lines_done = GREATEST(lines_done, COALESCE($2, lines_done)), claimed_by = NULL, last_error = NULL,
       staged_path = NULL
     WHERE chunk_id = $1`,
    [chunkId, totalLines ?? null]
  );
}

/** Gives a chunk back after the build gave up on it: anyone may retry it later, up to MAX_CHUNK_ATTEMPTS releases. */
export async function release(chunkId, error) {
  await query(
    `UPDATE ${QUEUE_TABLE} SET claimed_by = NULL, heartbeat_at = NULL,
       attempts = CASE WHEN failed_version IS DISTINCT FROM $3 THEN 1 ELSE attempts + 1 END, failed_version = $3, last_error = $2
     WHERE chunk_id = $1`,
    [chunkId, String(error ?? '').slice(0, 2000), codeVersion]
  );
}

/** Lets go of a chunk this worker claimed but never started (e.g. on shutdown), without counting an attempt. */
export async function unclaim(workerId, chunkId) {
  await query(`UPDATE ${QUEUE_TABLE} SET claimed_by = NULL, heartbeat_at = NULL WHERE chunk_id = $1 AND claimed_by = $2 AND done_at IS NULL`, [chunkId, workerId]);
}

/**
 * Corpus-wide progress for the display, the same for every worker.
 * @returns {{ chunks: number, doneChunks: number, linesDone: number, liveWorkers: string[], stuck: Array<{chunkId: string, attempts: number, lastError: string}>, rate: number|null, etaRate: number|null, activeMs: number }}
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
    `SELECT chunk_id, attempts, last_error FROM ${QUEUE_TABLE} WHERE done_at IS NULL AND attempts >= $1 AND failed_version IS NOT DISTINCT FROM $2 ORDER BY ord`,
    [MAX_CHUNK_ATTEMPTS, codeVersion]
  );
  const stats = await progressStats();
  return {
    chunks: totals.chunks,
    doneChunks: totals.done_chunks,
    linesDone: Number(totals.lines_done),
    liveWorkers: workers.map((w) => w.claimed_by).filter((w) => !w.endsWith(':reserved')),
    stuck: stuck.map((s) => ({ chunkId: s.chunk_id, attempts: s.attempts, lastError: s.last_error })),
    ...stats,
  };
}

/**
 * Chunks still to do that are NOT in `exclude` and not given up on for good:
 * claimable now, or held by another worker (whose lease may yet expire).
 */
export async function pendingCount(exclude = []) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM ${QUEUE_TABLE} WHERE done_at IS NULL AND (attempts < $2 OR failed_version IS DISTINCT FROM $3) AND NOT (chunk_id = ANY($1::text[]))`,
    [exclude, MAX_CHUNK_ATTEMPTS, codeVersion]
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
