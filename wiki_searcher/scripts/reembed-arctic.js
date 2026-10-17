#!/usr/bin/env node
/**
 * Re-embeds every paragraph in wiki_paragraph_embeddings with Snowflake
 * arctic-embed-m-v1.5 (wiki_searcher/arcticEmbeddings.js) into
 * wiki_paragraph_vectors_arctic — 256-dim halfvec, keyed by the paragraph's
 * id. Reads the text already stored in Postgres (no snapshot download) and
 * runs the model locally, so point EMBED_DEVICE at the GPU (webgpu/coreml on
 * a Mac) for speed.
 *
 * Built to run unattended for hours:
 * - Pipelined: the next batch downloads and the previous one uploads while the
 *   current one embeds, so the tunnel only slows things down if it's slower
 *   than the GPU. The table's Embed / Fetch / Upload columns show which is.
 * - Compact uploads: binary COPY of 16-bit vectors, ~520 bytes per row.
 * - Resumable: batches commit in id order, so a re-run picks up after the
 *   highest id already stored. Ctrl-C, a crash, or a tunnel drop loses at
 *   most the batch in flight.
 * - Retries connection errors indefinitely (with backoff), logging each one.
 * - Checks the halfvec encoding against the live database before writing.
 *
 * The existing bge index and the live site are untouched; this only adds rows
 * to the new table.
 *
 * Usage: node wiki_searcher/scripts/reembed-arctic.js [--limit N] [--batch N]
 *   --limit  stop after N paragraphs this run (a trial run; resumable as usual)
 *   --batch  paragraphs per database round trip (default 2048)
 *   EMBED_DEVICE / EMBED_DTYPE / EMBED_BATCH_SIZE as for the original build.
 */
import { Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import { loadEnv } from '../../imright/load-env.js';
import { formatDuration, fitToTerminal, tableBorder, tableRow } from './terminalTable.js';

loadEnv();
const { getPool } = await import('../../imright/scripts/db.js');
const { embedPassages, ARCTIC_DIMS, ARCTIC_MODEL } = await import('../arcticEmbeddings.js');
const { embedConfig, setLogger } = await import('../textEmbeddings.js');
const { encodeHalfvec, binaryCopyPayload } = await import('../vectorCopy.js');

const TARGET = 'wiki_paragraph_vectors_arctic';
const SOURCE = 'wiki_paragraph_embeddings';
const RENDER_MS = 500;
const RECENT = 20; // batches in the rolling stage-time averages

function parseArgs(argv) {
  const options = { limit: Infinity, batch: 2048 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') options.limit = Number(argv[++i]);
    else if (argv[i] === '--batch') options.batch = Number(argv[++i]);
  }
  return options;
}
const options = parseArgs(process.argv.slice(2));
if (!(options.limit > 0) || !(Number.isInteger(options.batch) && options.batch > 0)) {
  console.error('Usage: node wiki_searcher/scripts/reembed-arctic.js [--limit N] [--batch N]');
  process.exit(1);
}

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) first.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Marks a promise that's awaited later as handled, so a rejection in the meantime isn't an unhandled-rejection crash; the later await still throws it. */
const background = (promise) => {
  promise.catch(() => {});
  return promise;
};
const ms = (start) => performance.now() - start;

/** Real SQL errors (bad query, constraint violation) aren't worth retrying; connection trouble is. */
function isRetryable(error) {
  if (!(error instanceof pg.DatabaseError)) return true; // network/tunnel errors, timeouts
  return /^(08|57P|53)/.test(error.code) || error.code === '57014'; // connection, shutdown, resources, statement timeout
}

// ---------------------------------------------------------------- display

const display = (() => {
  const headers = ['Progress', 'Para/s', 'ETA', 'Embed', 'Fetch', 'Upload', 'Done (run)'];
  const BAR = 24;
  const widths = [BAR + 2 + 7, 6, 7, 6, 6, 6, 10];
  const aligns = ['left', 'right', 'right', 'right', 'right', 'right', 'right'];
  const isTTY = Boolean(process.stdout.isTTY);
  const recent = { embed: [], fetch: [], upload: [] };
  let state = { fraction: 0, doneThisRun: 0, startedAt: performance.now(), fractionAtStart: 0 };
  let timer = null;

  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN);
  const msCell = (list) => (list.length ? `${Math.round(avg(list))}` : '--');

  function cells() {
    const elapsed = (performance.now() - state.startedAt) / 1000;
    const rate = state.doneThisRun / elapsed;
    const fractionRate = (state.fraction - state.fractionAtStart) / elapsed;
    const eta = fractionRate > 0 ? (1 - state.fraction) / fractionRate : NaN;
    const filled = Math.round(Math.min(1, state.fraction) * BAR);
    return [
      `[${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}] ${(state.fraction * 100).toFixed(2).padStart(5)}%`,
      Number.isFinite(rate) ? rate.toFixed(0) : '--',
      formatDuration(eta),
      msCell(recent.embed),
      msCell(recent.fetch),
      msCell(recent.upload),
      state.doneThisRun.toLocaleString(),
    ];
  }
  const render = () => process.stdout.write(isTTY ? fitToTerminal(tableRow(cells(), widths, aligns)) : `${tableRow(cells(), widths, aligns)}\n`);
  const header = () => {
    console.log(tableBorder(widths));
    console.log(tableRow(headers, widths, headers.map(() => 'center')));
    console.log(tableBorder(widths));
  };

  return {
    start(initialFraction) {
      state = { fraction: initialFraction, doneThisRun: 0, startedAt: performance.now(), fractionAtStart: initialFraction };
      console.log('Embed / Fetch / Upload: ms per batch. The slowest one is the bottleneck (Fetch/Upload = tunnel, Embed = GPU).');
      header();
      render();
      if (isTTY) {
        process.stdout.write(`\n${tableBorder(widths)}\n`);
        timer = setInterval(() => { process.stdout.write('\x1b[2A'); render(); process.stdout.write('\x1b[2B'); }, RENDER_MS);
      } else {
        timer = setInterval(render, 30_000);
      }
      timer.unref();
    },
    record(stage, duration) {
      recent[stage].push(duration);
      if (recent[stage].length > RECENT) recent[stage].shift();
    },
    progress(fraction, rows) {
      state.fraction = fraction;
      state.doneThisRun += rows;
    },
    /** A message above the table, without breaking the in-place redraw. */
    log(message) {
      if (!isTTY || !timer) return console.log(message);
      process.stdout.write('\x1b[5A\r\x1b[0J');
      console.log(message);
      header();
      render();
      process.stdout.write(`\n${tableBorder(widths)}\n`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (isTTY) { process.stdout.write('\x1b[2A'); render(); process.stdout.write('\x1b[2B'); } else render();
    },
  };
})();

// ---------------------------------------------------------------- database

async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(attempt - 1, 5));
      display.log(`[${new Date().toLocaleTimeString()}] ${label} failed (${error.message}); retry ${attempt} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function fetchBatch(afterId) {
  const start = performance.now();
  const rows = await withRetry('fetch', async () => {
    const { rows } = await pool.query(
      `SELECT id, title, section, paragraph_text FROM ${SOURCE} WHERE id > $1 ORDER BY id LIMIT $2`,
      [afterId, options.batch]
    );
    return rows;
  });
  display.record('fetch', ms(start));
  return rows;
}

async function copyRows(client, rows) {
  const stream = client.query(copyStreams.from(`COPY ${TARGET} (id, embedding) FROM STDIN (FORMAT binary)`));
  await streamPipeline(Readable.from([binaryCopyPayload(rows)]), stream);
}

/** One COPY per batch: atomic, so the table never holds half a batch. */
async function uploadBatch(rows) {
  const start = performance.now();
  await withRetry('upload', async (attempt) => {
    let pending = rows;
    if (attempt > 1) {
      // The previous attempt may have committed before the connection died.
      const { rows: [{ max }] } = await pool.query(`SELECT max(id)::text AS max FROM ${TARGET}`);
      if (max !== null) pending = rows.filter(([id]) => BigInt(id) > BigInt(max));
      if (pending.length === 0) return;
    }
    const client = await pool.connect();
    const onError = () => {}; // a dropped connection rejects the COPY; don't also crash on the 'error' event
    client.on('error', onError);
    let broken = false;
    try {
      await copyRows(client, pending);
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.removeListener('error', onError);
      client.release(broken);
    }
  });
  display.record('upload', ms(start));
}

/** Round-trips one known vector through binary COPY into a temp halfvec column before writing real rows. */
async function checkEncoding() {
  const probe = Array.from({ length: ARCTIC_DIMS }, (_, i) => Math.sin(i + 1) / 10);
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE encoding_check (id bigint, embedding halfvec(${ARCTIC_DIMS}))`);
    const stream = client.query(copyStreams.from('COPY encoding_check (id, embedding) FROM STDIN (FORMAT binary)'));
    await streamPipeline(Readable.from([binaryCopyPayload([[1, encodeHalfvec(probe)]])]), stream);
    const { rows: [{ text }] } = await client.query('SELECT embedding::text AS text FROM encoding_check');
    const stored = JSON.parse(text);
    const worst = Math.max(...stored.map((v, i) => Math.abs(v - probe[i])));
    if (stored.length !== ARCTIC_DIMS || !(worst < 1e-3)) {
      throw new Error(`halfvec encoding check failed (dims ${stored.length}, worst error ${worst}) — nothing was written`);
    }
    await client.query('DROP TABLE encoding_check');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- main

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  display.log('Stopping after the batch in flight finishes uploading (Ctrl-C again to quit now; a re-run resumes either way)...');
});

try {
  const { device, dtype, batchSize } = embedConfig();
  console.log(`Re-embedding ${SOURCE} → ${TARGET} with ${ARCTIC_MODEL} (${ARCTIC_DIMS} dims, device: ${device}, dtype: ${dtype}, model batch ${batchSize}).`);

  await pool.query(`CREATE TABLE IF NOT EXISTS ${TARGET} (
    id        BIGINT PRIMARY KEY REFERENCES ${SOURCE} (id) ON DELETE CASCADE,
    embedding halfvec(${ARCTIC_DIMS}) NOT NULL
  )`);
  await checkEncoding();

  const { rows: [range] } = await pool.query(`SELECT min(id)::text AS min, max(id)::text AS max FROM ${SOURCE}`);
  const { rows: [{ resume }] } = await pool.query(`SELECT max(id)::text AS resume FROM ${TARGET}`);
  const minId = Number(range.min);
  const maxId = Number(range.max);
  let lastId = resume !== null ? Number(resume) : minId - 1;
  const fractionAt = (id) => Math.min(1, Math.max(0, (id - minId + 1) / (maxId - minId + 1)));
  if (lastId >= maxId) {
    console.log('Every paragraph already has an arctic vector — nothing to do.');
  } else {
    console.log(resume !== null ? `Resuming after id ${resume} (~${(fractionAt(lastId) * 100).toFixed(1)}% done).` : 'Starting from the beginning.');
    setLogger((message) => display.log(message)); // model download progress, above the table
    display.start(fractionAt(lastId));

    let remaining = options.limit;
    let next = background(fetchBatch(lastId));
    let pendingUpload = Promise.resolve();
    while (!interrupted && remaining > 0) {
      let rows = await next;
      if (rows.length === 0) break;
      if (rows.length > remaining) rows = rows.slice(0, remaining);
      const batchLastId = Number(rows[rows.length - 1].id);
      next = remaining - rows.length > 0 ? background(fetchBatch(batchLastId)) : Promise.resolve([]);

      const start = performance.now();
      const vectors = await embedPassages(rows.map((r) => `${r.title} — ${r.section}: ${r.paragraph_text}`));
      display.record('embed', ms(start));

      await pendingUpload; // keep uploads strictly in order (resume relies on it)
      const encoded = rows.map((r, i) => [r.id, encodeHalfvec(vectors[i])]);
      pendingUpload = background(uploadBatch(encoded).then(() => display.progress(fractionAt(batchLastId), encoded.length)));
      remaining -= rows.length;
      lastId = batchLastId;
    }
    await pendingUpload;
    display.stop();
    const { rows: [{ resume: now }] } = await pool.query(`SELECT max(id)::text AS resume FROM ${TARGET}`);
    if (now !== null && Number(now) >= maxId) {
      console.log(`\nDone at ${new Date().toLocaleString()}: every paragraph has an arctic vector.`);
    } else {
      console.log(`\nStopped at ${new Date().toLocaleString()} after id ${now} (~${(fractionAt(Number(now)) * 100).toFixed(1)}%). Re-run to continue.`);
    }
  }
} catch (error) {
  display.stop();
  console.error(`\nFatal error at ${new Date().toLocaleString()}: ${error.message}`);
  if (error.detail) console.error(`  ${error.detail}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
