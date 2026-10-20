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
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import pg from 'pg';
import { loadEnv } from '../../imright/load-env.js';

const execFileAsync = promisify(execFile);

loadEnv();

const port = Number(process.argv[2]) || 54329;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const CONSECUTIVE_FAILURES_BEFORE_RESTART = 2; // tolerate one blip; two in a row means the tunnel is actually dead, not just slow
const RESTART_BACKOFF_MS = 2_000; // brief pause before respawning, so a crash loop doesn't spin hot
const FORCE_KILL_GRACE_MS = 3_000; // how long SIGTERM gets before SIGKILL
const PORT_FREE_CHECK_INTERVAL_MS = 300;
const PORT_FREE_TIMEOUT_MS = 10_000; // give up waiting and attempt the start anyway -- railway's own error is at least visible then, instead of hanging forever
// A tunnel that is alive but SLOW is restarted too: observed live, write
// latency through `railway connect` creeps up over hours and a restart
// brings it back. Baseline = median round trip of the first few healthy
// checks after a (re)start; when LATENCY_SLOW_CHECKS consecutive checks
// exceed max(baseline × LATENCY_SLOW_FACTOR, baseline + LATENCY_SLOW_MIN_EXTRA_MS)
// the tunnel is restarted, at most once per LATENCY_RESTART_MIN_GAP_MS.
// Independently, TUNNEL_RESTART_EVERY_MIN (env, default 120; 0 = off)
// restarts it on a schedule as a preventive measure. Each restart costs the
// build a few seconds: its in-flight batches fail and are retried.
const LATENCY_BASELINE_SAMPLES = 5;
const LATENCY_SLOW_CHECKS = 4; // × HEALTH_CHECK_INTERVAL_MS = one minute of sustained slowness
const LATENCY_SLOW_FACTOR = 2.5;
const LATENCY_SLOW_MIN_EXTRA_MS = 300;
const LATENCY_RESTART_MIN_GAP_MS = 10 * 60_000;
const SCHEDULED_RESTART_MS = (process.env.TUNNEL_RESTART_EVERY_MIN !== undefined ? Number(process.env.TUNNEL_RESTART_EVERY_MIN) : 120) * 60_000;

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
let baselineSamples = []; // healthy round trips since the last (re)start, up to LATENCY_BASELINE_SAMPLES
let consecutiveSlow = 0;
let lastLatencyRestartAt = 0;
let tunnelStartedAt = 0;

function latencyBaselineMs() {
  if (baselineSamples.length < LATENCY_BASELINE_SAMPLES) return null;
  const sorted = [...baselineSamples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Kills whatever is actually LISTENING on `targetPort` right now, whether or
 * not it's a process this script itself started or still tracks.
 *
 * Waiting for a port to free on its own (see waitForPortFree below) only
 * helps when whatever was using it is already gone or on its way out. It
 * does nothing when the real problem is a still-ALIVE, ORPHANED tunnel
 * process from a previous run — e.g. one that survived the Mac sleeping
 * (observed live: a wake-from-sleep left a `railway connect` process
 * running with a broken tunnel underneath it, spewing "channel N: open
 * failed" forever, still holding the port, with no living parent process
 * left to signal it). A brand-new invocation of this script has no
 * `child` reference to that orphan at all, so it would otherwise just loop
 * forever: wait for the port, time out, try to start, hit "already in
 * use", exit, back off, repeat -- never actually clearing the real
 * blocker. Finding and killing whatever owns the port directly, regardless
 * of its origin, is the only thing that reliably unblocks this case.
 *
 * `-sTCP:LISTEN` is load-bearing, not optional. `lsof -ti :PORT` alone
 * matches every process with ANY socket referencing that port — that
 * includes every CLIENT connected to the tunnel (the build script's whole
 * pool of concurrent DB connections, this very script's own health-check
 * probes, anything else talking to Postgres through it), not just the one
 * process actually listening on it. Caused a real incident: the build
 * script got SIGTERM'd and died silently (no debug.log entry -- Node has no
 * default handler for SIGTERM, so it exits immediately, before any cleanup
 * or logging runs) every time this function ran and swept up its PID along
 * with the tunnel's. Verified directly against two separate real processes
 * (one listening, one only connected as a client) that the unfiltered form
 * returns both PIDs, while `-sTCP:LISTEN` returns only the listener.
 */
async function killWhateverIsOnPort(targetPort) {
  let pids;
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `:${targetPort}`, '-sTCP:LISTEN']);
    pids = [...new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean))];
  } catch {
    return; // lsof exits non-zero (with no output) when nothing matches the port -- nothing to kill
  }
  if (pids.length === 0) return;

  log(`⚠ port ${targetPort} is already held by PID(s) ${pids.join(', ')} (likely a leftover from a previous run) — killing directly`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, FORCE_KILL_GRACE_MS));
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone, or SIGTERM alone finished the job
    }
  }
}

/**
 * Resolves once `port` is actually free to bind on 127.0.0.1, or after
 * PORT_FREE_TIMEOUT_MS regardless (so a port that never frees up doesn't
 * hang the supervisor forever -- it just proceeds and lets railway's own
 * error surface, same as before this existed).
 *
 * Exists because killing `railway connect` (SIGTERM, waiting for its
 * process-group 'exit') doesn't guarantee the OS has released the port it
 * was listening on by the moment that 'exit' event fires — there can be a
 * brief lag (lingering sockets, TIME_WAIT-ish states) between "the process
 * is gone" and "the port is bindable again". Restarting the tunnel quickly
 * after a kill (e.g. right after the machine wakes from sleep) can race
 * that gap: `railway connect` refuses to start with "Local port X is
 * already in use" even though nothing is actually using it anymore in any
 * meaningful sense, it just hasn't been released yet. Waiting here instead
 * of immediately spawning closes that race for every (re)start path — the
 * first start, an exit-triggered restart, and a health-check-triggered one.
 *
 * killWhateverIsOnPort (above) handles the OTHER half of this: something
 * still alive and never going to free the port on its own. Both run before
 * every start attempt -- kill anything that's there, then confirm the OS
 * has actually let go of the port before trying to bind it ourselves.
 */
function waitForPortFree(targetPort) {
  return new Promise((resolve) => {
    const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
    function attempt() {
      const probe = net.createServer();
      probe.once('error', () => {
        if (Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(attempt, PORT_FREE_CHECK_INTERVAL_MS);
      });
      probe.once('listening', () => probe.close(() => resolve()));
      probe.listen(targetPort, '127.0.0.1');
    }
    attempt();
  });
}

async function startTunnel() {
  await killWhateverIsOnPort(port);
  await waitForPortFree(port);
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
  baselineSamples = [];
  consecutiveSlow = 0;
  if (dying) await killChild(dying);
  startTunnel();
  tunnelStartedAt = Date.now();
}

/**
 * Returns both pass/fail AND the round-trip time, not just a boolean — the
 * build script's own per-article DB round trips go through this same
 * tunnel, so a tunnel that's merely SLOW (not dead) looks identical to "the
 * embedding is just slow" from the build script's side alone. Logging this
 * number on every check (see healthLoop) gives a direct, continuous answer
 * to "is the tunnel the bottleneck" instead of guessing between that and
 * local CPU.
 */
async function checkHealth() {
  const client = new pg.Client({
    connectionString: healthCheckConnectionString(),
    ssl: false, // always 127.0.0.1 here — this script only ever points at its own local tunnel
    connectionTimeoutMillis: HEALTH_CHECK_TIMEOUT_MS,
    statement_timeout: HEALTH_CHECK_TIMEOUT_MS,
  });
  const start = Date.now();
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  } finally {
    client.end().catch(() => {}); // best-effort — a client from a broken connection may already be dead
  }
}

async function healthLoop() {
  if (stopping || !child) return; // no tunnel process to check right now (mid-restart) — skip this tick rather than false-alarming
  const { healthy, latencyMs } = await checkHealth();
  if (healthy) {
    if (consecutiveFailures > 0) log('✓ tunnel healthy again');
    consecutiveFailures = 0;
    const baseline = latencyBaselineMs();
    if (baseline === null) {
      baselineSamples.push(latencyMs);
      log(`  tunnel round trip: ${latencyMs}ms${latencyBaselineMs() !== null ? ` (baseline ${latencyBaselineMs()}ms)` : ''}`);
      return;
    }
    const slowAbove = Math.max(baseline * LATENCY_SLOW_FACTOR, baseline + LATENCY_SLOW_MIN_EXTRA_MS);
    if (latencyMs > slowAbove) {
      consecutiveSlow++;
      log(`  tunnel round trip: ${latencyMs}ms — slow (${consecutiveSlow}/${LATENCY_SLOW_CHECKS}; baseline ${baseline}ms, restart above ${Math.round(slowAbove)}ms)`);
      if (consecutiveSlow >= LATENCY_SLOW_CHECKS && Date.now() - lastLatencyRestartAt >= LATENCY_RESTART_MIN_GAP_MS) {
        lastLatencyRestartAt = Date.now();
        log('✗ tunnel has been slow for a minute — restarting it (the build retries its in-flight batches)');
        restartTunnel();
      }
    } else {
      consecutiveSlow = 0;
      log(`  tunnel round trip: ${latencyMs}ms`);
    }
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
tunnelStartedAt = Date.now();
setInterval(healthLoop, HEALTH_CHECK_INTERVAL_MS);
if (SCHEDULED_RESTART_MS > 0) {
  log(`scheduled restart every ${SCHEDULED_RESTART_MS / 60_000} min (TUNNEL_RESTART_EVERY_MIN=0 disables)`);
  setInterval(() => {
    if (stopping || !child || Date.now() - tunnelStartedAt < SCHEDULED_RESTART_MS - HEALTH_CHECK_INTERVAL_MS) return;
    log('↻ scheduled restart (preventive; the build retries its in-flight batches)');
    restartTunnel();
  }, HEALTH_CHECK_INTERVAL_MS);
}
