#!/usr/bin/env node
/**
 * Supervises `railway connect postgres --tunnel-only` so a dropped SSH
 * tunnel gets replaced automatically instead of quietly breaking every
 * script that talks to Postgres through it (build-index-from-wikimedia.js,
 * refresh-daily.js, etc. — anything pointed at DATABASE_URL's 127.0.0.1
 * port).
 *
 * A dead tunnel doesn't always mean a dead PROCESS — the observed fix has
 * been to manually kill and restart `railway connect` even though it was
 * still running, meaning the process stays up with a stale/broken
 * connection underneath it. A plain "respawn on exit" wrapper wouldn't
 * catch that, so this instead health-checks the tunnel by making a REAL
 * Postgres round trip (SELECT 1) through it on an interval, and only kills
 * + restarts the tunnel when that actually fails a couple of times in a
 * row. A bare TCP-connect probe would miss exactly this case: the local
 * end can stay open and accept connections even after the tunnel itself is
 * dead.
 *
 * Usage: node wiki_searcher/scripts/db-tunnel.js [port]
 *   port - local port to tunnel on (default 54329). Point DATABASE_URL's
 *          host:port at 127.0.0.1:<port> (see imright/load-env.js) for the
 *          duration this is running — the health check itself doesn't
 *          trust DATABASE_URL's cached host/port; it only borrows the
 *          user/password/dbname and always targets 127.0.0.1:<port>.
 *
 * Leave this running in its own terminal for the duration of a long build;
 * Ctrl-C stops both this and the tunnel underneath it.
 */
import { spawn } from 'child_process';
import pg from 'pg';
import { loadEnv } from '../../imright/load-env.js';

loadEnv();

const port = Number(process.argv[2]) || 54329;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const CONSECUTIVE_FAILURES_BEFORE_RESTART = 2; // tolerate one blip; two in a row means the tunnel is actually dead, not just slow
const RESTART_BACKOFF_MS = 2_000; // brief pause before respawning, so a crash loop doesn't spin hot
const FORCE_KILL_GRACE_MS = 3_000; // how long SIGTERM gets before SIGKILL

if (!process.env.DATABASE_URL) {
  console.error(
    '[tunnel] DATABASE_URL is not set — need its user/password/dbname to health-check the tunnel. Set it in env.local and re-run.'
  );
  process.exit(1);
}

/**
 * DATABASE_URL's credentials/dbname, but always pointed at 127.0.0.1:<port>.
 * Whatever host/port happen to be cached in DATABASE_URL right now don't
 * matter here — this script owns the tunnel and knows exactly where it's
 * actually listening, which is the whole point of health-checking through
 * it rather than trusting a possibly-stale env var.
 */
function healthCheckConnectionString() {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

function log(message) {
  console.log(`[tunnel ${new Date().toISOString()}] ${message}`);
}

let child = null;
let stopping = false;
let consecutiveFailures = 0;

function startTunnel() {
  log(`⏳ starting — railway connect postgres --tunnel-only -P ${port}`);
  // detached so `railway` (and anything it forks internally, e.g. its own
  // ssh subprocess) lands in its own process group — killing that whole
  // group on restart (see killChild) is more reliable than killing just the
  // one PID we got back from spawn(), which wouldn't necessarily reach a
  // grandchild process.
  child = spawn('railway', ['connect', 'postgres', '--tunnel-only', '-P', String(port)], {
    stdio: 'inherit',
    detached: true,
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    log(`✗ tunnel process exited (code ${code ?? '?'}, signal ${signal ?? 'none'}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
    consecutiveFailures = 0;
    setTimeout(startTunnel, RESTART_BACKOFF_MS);
  });

  child.on('error', (err) => {
    log(`✗ failed to launch the railway CLI: ${err.message} — is it installed and on PATH?`);
  });
}

/** Kills `proc` (and its process group) and resolves once it has actually exited. */
function killChild(proc) {
  return new Promise((resolve) => {
    proc.removeAllListeners('exit'); // this kill is deliberate — don't let the old process's own exit handler ALSO schedule a respawn
    const forceKillTimer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // already dead — fine
      }
    }, FORCE_KILL_GRACE_MS);
    proc.on('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      clearTimeout(forceKillTimer);
      resolve(); // already gone
    }
  });
}

async function restartTunnel() {
  const dying = child;
  child = null; // treat as "no tunnel" immediately so a concurrent health-check tick doesn't race this restart
  if (dying) await killChild(dying);
  startTunnel();
}

async function checkHealth() {
  const client = new pg.Client({
    connectionString: healthCheckConnectionString(),
    ssl: false, // always 127.0.0.1 here — this script only ever points at its own local tunnel
    connectionTimeoutMillis: HEALTH_CHECK_TIMEOUT_MS,
    statement_timeout: HEALTH_CHECK_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    client.end().catch(() => {}); // best-effort — a client from a broken connection may already be dead
  }
}

async function healthLoop() {
  if (stopping || !child) return; // no tunnel process to check right now (mid-restart) — skip this tick rather than false-alarming
  const healthy = await checkHealth();
  if (healthy) {
    if (consecutiveFailures > 0) log('✓ tunnel healthy again');
    consecutiveFailures = 0;
    return;
  }

  consecutiveFailures++;
  log(`⚠ health check failed (${consecutiveFailures}/${CONSECUTIVE_FAILURES_BEFORE_RESTART})`);
  if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_RESTART) {
    consecutiveFailures = 0;
    log('✗ tunnel unresponsive — restarting it');
    restartTunnel();
  }
}

async function shutdown() {
  stopping = true;
  log('stopping...');
  if (child) await killChild(child);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startTunnel();
setInterval(healthLoop, HEALTH_CHECK_INTERVAL_MS);
