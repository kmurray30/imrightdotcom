#!/usr/bin/env node
/**
 * Builds the vector search index (ivfflat) on wiki_paragraph_embeddings. Run
 * once AFTER the table is fully loaded (build-index-from-wikimedia.js), and
 * again only if the data changes a lot. ivfflat computes its cluster centers
 * from the rows present at build time, so an index created on an empty or
 * half-loaded table searches badly no matter how much data arrives later —
 * which is exactly what the schema file used to do.
 *
 * Also drops wiki_paragraph_embeddings_title if present: UNIQUE (title,
 * paragraph_index) already provides an index with title as its leading
 * column, which serves every title lookup, so the separate index only cost
 * disk and write time.
 *
 * Safe to stop and re-run at any point:
 * - Ctrl-C (or a dropped tunnel) only detaches. The build is one CREATE INDEX
 *   statement running inside Postgres, which doesn't notice its client going
 *   away mid-statement (this script sets client_connection_check_interval = 0
 *   to guarantee that), so it carries on to the end and commits.
 * - Re-running while a build is going reattaches to it: same progress table,
 *   then the final ANALYZE once it completes.
 * - --cancel actually stops a running build. CREATE INDEX is all-or-nothing:
 *   a cancelled or failed build leaves no partial index behind, and the next
 *   run starts it over from scratch.
 * - If a usable index already exists (i.e. not the original empty-table one),
 *   it's left alone unless --rebuild is passed.
 *
 * maintenance_work_mem is sized automatically: pgvector's k-means step needs
 * memory that grows with lists² (≈4.8GB at lists ≈ 4800) and fails outright,
 * after several minutes of sampling, if it doesn't get it.
 *
 * Usage: node wiki_searcher/scripts/create-ann-index.js [--rebuild | --cancel]
 *   LISTS (default: from row count), MAINTENANCE_WORK_MEM (default: sized to
 *   the build, e.g. "6GB"), PARALLEL_WORKERS (default 8)
 */
import pg from 'pg';
import { loadEnv } from '../../imright/load-env.js';
import { shouldUseSsl } from '../../imright/scripts/db.js';
import { formatDuration, fitToTerminal, tableBorder, tableRow } from './terminalTable.js';

loadEnv();

const TABLE = 'wiki_paragraph_embeddings';
const INDEX_NAME = 'wiki_paragraph_embeddings_ann';
const EMPTY_TABLE_INDEX_LISTS = 200; // what the schema file used to create on the empty table
const ADVISORY_LOCK_KEY = 7_342_001; // arbitrary; held by the session that sets up and runs the build, so two runs can't both start one
const SAMPLES_PER_LIST = 50; // pgvector's ivfflat k-means trains on lists × 50 sampled rows
const MIN_MEMORY_MB = 2048;
const MAX_AUTO_MEMORY_MB = 12 * 1024; // half the Postgres service's 24GB RAM; past this, lower LISTS instead
const POLL_MS = 5_000;
const RENDER_MS = 250;
const NON_TTY_PRINT_MS = 30_000;
const BAR_WIDTH = 24;

const args = new Set(process.argv.slice(2));
const rebuild = args.has('--rebuild');
const cancel = args.has('--cancel');
const parallelWorkers = Number(process.env.PARALLEL_WORKERS) || 8;
const listsOverride = Number(process.env.LISTS) || null;
const memoryOverrideMB = process.env.MAINTENANCE_WORK_MEM ? parseMemoryMB(process.env.MAINTENANCE_WORK_MEM) : null;

if (process.env.MAINTENANCE_WORK_MEM && memoryOverrideMB == null) {
  console.error(`MAINTENANCE_WORK_MEM must look like "6GB" or "512MB" (got "${process.env.MAINTENANCE_WORK_MEM}").`);
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) and re-run.');
  process.exit(1);
}

function parseMemoryMB(text) {
  const match = /^(\d+)\s*(kB|MB|GB)$/.exec(text.trim());
  if (!match) return null;
  return Math.ceil(Number(match[1]) * { kB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]);
}

function formatMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)}GB` : `${mb}MB`;
}

function formatGB(bytes) {
  return `${(Number(bytes) / 1e9).toFixed(1)} GB`;
}

/** pgvector's guidance: lists = rows / 1000 up to 1M rows, sqrt(rows) beyond. */
function defaultLists(rowCount) {
  return Math.max(10, Math.round(rowCount <= 1_000_000 ? rowCount / 1000 : Math.sqrt(rowCount)));
}

/** Query-time recall starting point: probes ≈ sqrt(lists). */
function probesFor(lists) {
  return Math.max(1, Math.round(Math.sqrt(lists)));
}

function listsFromDef(text) {
  const match = /lists\s*=\s*'?(\d+)'?/.exec(text ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Approximately what pgvector's k-means (ivfkmeans.c, ElkanKmeans) checks
 * against maintenance_work_mem before it starts: the sampled vectors, a few
 * center arrays, and — dominating everything — a samples × lists float matrix
 * of distance bounds, which is why this grows with lists².
 */
function kmeansMemoryBytes(lists, dimensions) {
  const samples = lists * SAMPLES_PER_LIST;
  const vectorBytes = Math.ceil((8 + 4 * dimensions) / 8) * 8; // varlena header + dims + float4s, MAXALIGNed
  return (
    samples * vectorBytes + // the samples
    3 * lists * vectorBytes + // centers, new centers, running sums
    samples * lists * 4 + // per-sample lower bounds to every center
    lists * lists * 4 + // half center-to-center distances
    2 * samples * 4 + // closest center + upper bound per sample
    4 * lists * 4 // per-center counts and distances
  );
}

const STEPS = [
  { match: 'initializing', label: '1/4 init' },
  { match: 'k-means', label: '2/4 k-means' },
  { match: 'assigning', label: '3/4 assigning' },
  { match: 'loading', label: '4/4 loading' },
];

function printStepLegend(lists) {
  const centers = lists ? `${lists.toLocaleString()} cluster centers` : 'the cluster centers';
  console.log(
    `Steps: 1 init → 2 k-means (samples rows, then finds ${centers}; Postgres reports no % for this step, ` +
      'the bar just shows it\'s alive) → 3 assigning (reads every row) → 4 loading (writes the index).'
  );
}

/**
 * One-row progress table for a CREATE INDEX running in backend `pid`, polled
 * from the separate monitor connection (the build's own connection is busy
 * for the whole statement). Same in-place layout as
 * build-index-from-wikimedia.js's table. Data is polled every POLL_MS; the
 * row re-renders more often so the clocks tick and the k-means bar (which has
 * no real % to show) visibly moves.
 */
function createBuildDisplay(monitor, pid, { attached }) {
  // Elapsed: since CREATE INDEX started (server clock). In step: since this
  // run first saw the current step ("≥" when reattaching mid-step, since the
  // true start of that step isn't recorded anywhere). Step ETA: only for the
  // steps Postgres reports a % for. DB size grows as the index is written;
  // Temp is the build's sort spill, freed when it finishes.
  const headers = ['Step', 'Progress', 'Elapsed', 'In step', 'Step ETA', 'DB size', 'Temp'];
  const widths = [13, BAR_WIDTH + 2 + 1 + 6, 7, 7, 8, 8, 8].map((w, i) => Math.max(w, headers[i].length));
  const aligns = ['left', 'left', 'right', 'right', 'right', 'right', 'right'];
  const isTTY = Boolean(process.stdout.isTTY);

  let sample = null; // latest poll result
  let step = null; // { label, since, partial, fraction0, at0 }
  let sawProgress = false;
  let tempSupported = true;
  let tempBytes = null;
  let failures = 0;
  let stopped = false;
  let pollTimer = null;
  let renderTimer = null;
  let settle = null;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {}); // only awaited when reattached; a normal-mode poll failure must not become an unhandled rejection

  async function readTempBytes() {
    // Superuser-only file functions; shown as "-" if not permitted. Parallel
    // builds keep their sort files in per-build subdirectories, one level down.
    const { rows: entries } = await monitor.query(
      `SELECT f AS name, s.size, s.isdir
       FROM pg_ls_dir('base/pgsql_tmp', true, false) f, LATERAL pg_stat_file('base/pgsql_tmp/' || f, true) s`
    );
    let total = 0;
    for (const entry of entries) {
      if (!entry.isdir) {
        total += Number(entry.size ?? 0);
        continue;
      }
      const dir = `base/pgsql_tmp/${entry.name}`;
      const { rows: [{ bytes }] } = await monitor.query(
        `SELECT coalesce(sum(s.size), 0)::bigint AS bytes
         FROM pg_ls_dir($1, true, false) f, LATERAL pg_stat_file($1 || '/' || f, true) s
         WHERE NOT coalesce(s.isdir, true)`,
        [dir]
      );
      total += Number(bytes);
    }
    return total;
  }

  async function poll() {
    const { rows } = await monitor.query(
      `SELECT a.state, extract(epoch FROM now() - a.query_start)::float8 AS elapsed_s,
              p.phase, p.blocks_done, p.blocks_total, p.tuples_done, p.tuples_total,
              pg_database_size(current_database()) AS db_bytes
       FROM pg_stat_activity a LEFT JOIN pg_stat_progress_create_index p ON p.pid = a.pid
       WHERE a.pid = $1`,
      [pid]
    );
    const row = rows[0];
    const active = row?.state === 'active';
    if (tempSupported) {
      try {
        tempBytes = await readTempBytes();
      } catch {
        tempSupported = false;
        tempBytes = null;
      }
    }

    let fraction = null;
    if (row && Number(row.tuples_total) > 0) fraction = Number(row.tuples_done) / Number(row.tuples_total);
    else if (row && Number(row.blocks_total) > 0) fraction = Number(row.blocks_done) / Number(row.blocks_total);

    let label;
    if (row?.phase) {
      sawProgress = true;
      label = STEPS.find((s) => row.phase.includes(s.match))?.label ?? row.phase.replace(/^building index: /, '');
    } else {
      label = sawProgress ? 'finishing' : 'starting';
    }
    const now = Date.now();
    if (!step || step.label !== label) {
      step = { label, since: now, partial: attached && !step && Boolean(row?.phase), fraction0: null, at0: null };
    }
    if (fraction != null && step.fraction0 == null) {
      step.fraction0 = fraction;
      step.at0 = now;
    }
    sample = { polledAt: now, elapsedS: row ? Number(row.elapsed_s) : null, dbBytes: row?.db_bytes ?? null, fraction };

    // Reattached: the build's backend going idle (or away) means CREATE INDEX
    // has finished — committed or rolled back; the caller checks which.
    if (attached && !active) settle.resolve();
  }

  async function pollLoop() {
    try {
      await poll();
      failures = 0;
    } catch (error) {
      if (++failures >= 3) {
        settle.reject(error);
        return;
      }
    }
    if (!stopped) pollTimer = setTimeout(pollLoop, POLL_MS);
  }

  function bar(fraction) {
    if (fraction != null) {
      const filled = Math.round(Math.min(1, fraction) * BAR_WIDTH);
      return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}] ${(fraction * 100).toFixed(1).padStart(5)}%`;
    }
    // No % available: a small block bouncing back and forth, so a long
    // k-means step still visibly shows the script is alive.
    const span = BAR_WIDTH - 3;
    const tick = Math.floor(Date.now() / 150) % (2 * span);
    const pos = tick < span ? tick : 2 * span - tick;
    return `[${'░'.repeat(pos)}███${'░'.repeat(span - pos)}]     --`;
  }

  function cells() {
    if (!sample) return ['connecting', bar(null), '--', '--', '--', '--', '--'];
    const now = Date.now();
    const elapsed = sample.elapsedS != null ? sample.elapsedS + (now - sample.polledAt) / 1000 : NaN;
    let eta = NaN;
    if (sample.fraction != null && step.fraction0 != null && sample.fraction > step.fraction0) {
      const ratePerMs = (sample.fraction - step.fraction0) / (sample.polledAt - step.at0);
      eta = (1 - sample.fraction) / ratePerMs / 1000 - (now - sample.polledAt) / 1000;
    }
    return [
      step.label,
      bar(sample.fraction),
      formatDuration(elapsed),
      (step.partial ? '≥' : '') + formatDuration((now - step.since) / 1000),
      formatDuration(Math.max(0, eta)),
      sample.dbBytes != null ? formatGB(sample.dbBytes) : '--',
      tempBytes != null ? formatGB(tempBytes) : '-',
    ];
  }

  function render() {
    const row = tableRow(cells(), widths, aligns);
    process.stdout.write(isTTY ? fitToTerminal(row) : row);
  }

  // The data row sits one line above the bottom border, which sits one line
  // above the resting cursor (see start()): up 2, rewrite, back down 2.
  function renderInPlace() {
    process.stdout.write('\x1b[2A');
    render();
    process.stdout.write('\x1b[2B');
  }

  return {
    start() {
      console.log(tableBorder(widths));
      console.log(tableRow(headers, widths, headers.map(() => 'center')));
      console.log(tableBorder(widths));
      render();
      process.stdout.write(`\n${tableBorder(widths)}\n`);
      if (isTTY) {
        renderTimer = setInterval(renderInPlace, RENDER_MS);
      } else {
        // No cursor movement when piped to a file: append a row now and then instead.
        renderTimer = setInterval(() => console.log(tableRow(cells(), widths, aligns)), NON_TTY_PRINT_MS);
      }
      renderTimer.unref();
      pollLoop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(renderTimer);
      if (isTTY) renderInPlace();
    },
    /** Reattached mode only: resolves once the build's backend is no longer running it. */
    waitUntilDone() {
      return done;
    },
  };
}

const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false;
const client = new pg.Client({ connectionString, ssl }); // runs setup, the build, and ANALYZE
const monitor = new pg.Client({ connectionString, ssl }); // progress polling while `client` is busy
// A dropped connection also rejects whatever query is in flight, which is
// where it's reported; without a listener, the 'error' event would crash.
for (const c of [client, monitor]) c.on('error', () => {});

// 'setup' → 'building' → 'analyzing' → 'done', or 'attached' when reattaching.
let stage = 'setup';
let display = null;

process.on('SIGINT', () => {
  display?.stop();
  display = null;
  if (stage === 'building' || stage === 'attached') {
    console.log('\nDetached. The index build keeps running inside Postgres — re-run this script to watch it again, or run it with --cancel to stop it.');
  } else if (stage === 'analyzing') {
    console.log('\nThe index is already built; only the final ANALYZE was interrupted (it finishes on its own on the server). Nothing else to do.');
  } else {
    console.log('\nStopped before the index build started — nothing to clean up. Re-run whenever.');
  }
  process.exit(130);
});

async function findRunningBuild() {
  const { rows } = await monitor.query(
    `SELECT p.pid, extract(epoch FROM now() - a.query_start)::float8 AS elapsed_s, a.query
     FROM pg_stat_progress_create_index p JOIN pg_stat_activity a ON a.pid = p.pid
     WHERE p.relid = $1::regclass LIMIT 1`,
    [TABLE]
  );
  return rows[0] ?? null;
}

async function getExistingIndex() {
  const { rows } = await monitor.query(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
    [INDEX_NAME]
  );
  return rows[0] ?? null;
}

async function cancelBuild(running) {
  if (!running) {
    console.log('No index build is running — nothing to cancel.');
    return;
  }
  await monitor.query('SELECT pg_cancel_backend($1)', [running.pid]);
  for (let i = 0; i < 60; i++) {
    if (!(await findRunningBuild())) {
      console.log(`Cancelled the build (it had been running ${formatDuration(running.elapsed_s)}). Nothing half-built is left behind; re-run without --cancel to start over.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('Sent the cancel, but the build hasn\'t stopped after 60s — re-run with --cancel to check again.');
}

async function finishUp() {
  stage = 'analyzing';
  console.log('Running ANALYZE...');
  await client.query('SET statement_timeout = 0');
  await client.query(`ANALYZE ${TABLE}`);
  const { rows: [{ size, def }] } = await client.query(
    'SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS size, pg_get_indexdef($1::regclass) AS def',
    [INDEX_NAME]
  );
  const lists = listsFromDef(def);
  console.log(`\nDone at ${new Date().toLocaleString()}. ${INDEX_NAME}: ${size}, lists = ${lists}.`);
  console.log(`Query-time recall setting: VECTOR_SEARCH_PROBES=${probesFor(lists)} (≈ sqrt(lists); compare utils/vectorIndex.js's default).`);
  stage = 'done';
}

async function reattach(running) {
  stage = 'attached';
  console.log(`An index build is already running on the server (started ${formatDuration(running.elapsed_s)} ago) — reattaching.`);
  printStepLegend(listsFromDef(running.query));
  console.log('Ctrl-C detaches again without stopping it.');
  display = createBuildDisplay(monitor, running.pid, { attached: true });
  display.start();
  await display.waitUntilDone();
  display.stop();
  display = null;

  const current = await getExistingIndex();
  if (current?.valid) {
    await finishUp();
  } else {
    console.log(
      '\nThe build ended without creating the index — it was cancelled or failed (Railway\'s Postgres logs say which). ' +
        'A failed CREATE INDEX is rolled back completely, so nothing was left behind; re-run to start it over.'
    );
    process.exitCode = 1;
  }
}

async function startBuild() {
  const current = await getExistingIndex();
  const isEmptyTableIndex = current && listsFromDef(current.def) === EMPTY_TABLE_INDEX_LISTS;
  if (current && current.valid && !isEmptyTableIndex && !rebuild) {
    const lists = listsFromDef(current.def);
    console.log(`A usable ${INDEX_NAME} already exists:\n  ${current.def}`);
    console.log(`Nothing to do (pass --rebuild to build it again). Recommended VECTOR_SEARCH_PROBES=${probesFor(lists)}.`);
    return;
  }

  const { rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
  if (!locked) {
    console.log('Another run of this script is still in its setup steps — wait a minute, then re-run to attach to its build.');
    return;
  }

  console.log('Counting rows...');
  const { rows: [{ n }] } = await client.query(`SELECT count(*)::bigint AS n FROM ${TABLE}`);
  const rowCount = Number(n);
  const { rows: [{ dims }] } = await client.query(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'embedding'`,
    [TABLE]
  );
  const lists = listsOverride ?? defaultLists(rowCount);
  const neededMB = Math.ceil(kmeansMemoryBytes(lists, Number(dims)) / 2 ** 20);

  // Settle memory before touching anything, so a bad setting fails here
  // instead of after the old index is gone and minutes of sampling are spent.
  let memoryMB;
  if (memoryOverrideMB != null) {
    if (memoryOverrideMB < neededMB) {
      throw new Error(`MAINTENANCE_WORK_MEM=${process.env.MAINTENANCE_WORK_MEM} is below the ~${formatMB(neededMB)} k-means needs at lists = ${lists}. Raise it, or lower LISTS. Nothing was changed.`);
    }
    memoryMB = memoryOverrideMB;
  } else {
    memoryMB = Math.max(MIN_MEMORY_MB, Math.ceil((neededMB * 1.15) / 1024) * 1024); // 15% headroom, rounded up to whole GB
    if (memoryMB > MAX_AUTO_MEMORY_MB) {
      throw new Error(`lists = ${lists} needs ~${formatMB(neededMB)} for k-means, more than this script will claim on its own. Set a smaller LISTS, or MAINTENANCE_WORK_MEM explicitly. Nothing was changed.`);
    }
  }

  await client.query('SET statement_timeout = 0');
  // So a client that goes away mid-build (Ctrl-C, tunnel drop) never cancels
  // it; 0 is Postgres's default, set explicitly so the header's promise
  // holds regardless of server config. Pre-14 servers lack the setting and
  // never check anyway.
  await client.query('SET client_connection_check_interval = 0').catch(() => {});
  await client.query(`SET maintenance_work_mem = '${memoryMB}MB'`);
  await client.query(`SET max_parallel_maintenance_workers = ${parallelWorkers}`);

  const annToDrop = current ? (isEmptyTableIndex ? 'the empty-table ANN index' : 'the existing ANN index') : null;
  console.log(`Dropping ${annToDrop ? `${annToDrop} and ` : ''}the redundant title index (if present)...`);
  await client.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await client.query('DROP INDEX IF EXISTS wiki_paragraph_embeddings_title');

  const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
  console.log(
    `Building ivfflat index: ${rowCount.toLocaleString()} rows, lists = ${lists}, maintenance_work_mem ${formatMB(memoryMB)} ` +
      `(k-means needs ~${formatMB(neededMB)}), up to ${parallelWorkers} parallel workers.`
  );
  printStepLegend(lists);
  console.log('Ctrl-C detaches without stopping the build; re-run this script to reattach, or with --cancel to stop it.');

  stage = 'building';
  display = createBuildDisplay(monitor, pid, { attached: false });
  display.start();
  try {
    await client.query(`CREATE INDEX ${INDEX_NAME} ON ${TABLE} USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`);
  } finally {
    display.stop();
    display = null;
  }
  await finishUp();
}

function reportFailure(error) {
  display?.stop();
  display = null;
  console.error(`\nFailed at ${new Date().toLocaleString()}: ${error.message}`);
  const fromServer = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
  if (stage === 'building' && fromServer) {
    console.error('Postgres rolled the build back completely — nothing half-built was left behind. Re-running starts it over.');
    if (/memory required/i.test(error.message)) {
      console.error('Out of build memory: re-run with a larger MAINTENANCE_WORK_MEM (e.g. MAINTENANCE_WORK_MEM=8GB) or a smaller LISTS.');
    }
  } else if (stage === 'building' || stage === 'attached') {
    console.error('Lost the connection, but the build itself keeps running inside Postgres. Re-run this script to reattach to it.');
  }
}

try {
  await client.connect();
  await monitor.connect();
  const running = await findRunningBuild();
  if (cancel) await cancelBuild(running);
  else if (running) await reattach(running);
  else await startBuild();
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  await monitor.end().catch(() => {});
}
