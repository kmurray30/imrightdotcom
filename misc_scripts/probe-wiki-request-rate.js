#!/usr/bin/env node
/**
 * Measures two MediaWiki API rate-limit properties:
 *
 *   Test A — Requests-per-window ceiling
 *     Waits for a verified clean window, then fires sequential requests
 *     until the first 429. Repeats TRIAL_COUNT times (each separated by
 *     a full window cooldown) to get a robust confident number.
 *
 *   Test B — Does inter-request spacing matter?
 *     Compares two burst strategies back-to-back:
 *       - No delay (fire as fast as possible)
 *       - Evenly-spaced (budget / window_ms per request)
 *     If both hit the same count ceiling, delay is irrelevant; only count
 *     matters. If spaced requests last longer without 429, delay matters too.
 *
 * Usage:  node misc_scripts/probe-wiki-request-rate.js
 */

const WIKI_API    = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT  = 'imright-rate-probe/1.0 (educational research)';
const PROBE_QUERY = 'history';

// How many independent trials to run for Test A (more = tighter confidence).
const TRIAL_COUNT = 4;

// Extra buffer added to Retry-After before declaring the window "clear".
const RETRY_AFTER_BUFFER_MS = 3000;

// ─── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

function fmt(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
  if (ms >= 1000)   return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

/**
 * Single request. Returns { ok, status, response, roundTripMs }.
 */
async function singleRequest() {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', PROBE_QUERY);
  url.searchParams.set('srlimit', '1');
  url.searchParams.set('format', 'json');

  const startTime = Date.now();
  try {
    const response = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
    return {
      ok:           response.status === 200,
      status:       response.status,
      response,
      roundTripMs:  Date.now() - startTime,
    };
  } catch (error) {
    return { ok: false, status: 'network_error', response: null, roundTripMs: Date.now() - startTime };
  }
}

/**
 * Honour the Retry-After header and return the actual wait duration.
 */
async function coolDown(response, label = '') {
  const rawHeader = response?.headers?.get('retry-after');
  const seconds   = rawHeader ? parseFloat(rawHeader) : NaN;
  const waitMs    = (isNaN(seconds) ? 65 : Math.ceil(seconds) + 5) * 1000;
  const retryAfterSec = isNaN(seconds) ? '(none)' : `${rawHeader}s`;
  log(`  ⏳ Retry-After: ${retryAfterSec}${label} → cooling down ${fmt(waitMs)}`);
  await sleep(waitMs + RETRY_AFTER_BUFFER_MS);
  return waitMs;
}

/**
 * Verify the API accepts requests before measuring.
 * Returns the Retry-After value seen (if any) for window-size estimation.
 */
async function waitUntilReady(label = '') {
  process.stdout.write(`[ready check${label}]`);
  let attempt = 0;
  let lastRetryAfterMs = null;
  while (true) {
    attempt++;
    const { ok, response } = await singleRequest();
    if (ok) { log(` ✓ (attempt ${attempt})\n`); return lastRetryAfterMs; }
    process.stdout.write(` 429`);
    lastRetryAfterMs = await coolDown(response);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST A — requests-per-window ceiling
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fire sequential requests as fast as possible until the first 429.
 * Returns { successCount, elapsedMs, retryAfterMs }.
 */
async function burstUntil429(delayMs = 0) {
  let successCount = 0;
  const startTime  = Date.now();
  const rtts       = [];

  while (true) {
    if (delayMs > 0 && successCount > 0) await sleep(delayMs);
    const { ok, roundTripMs, response } = await singleRequest();
    if (ok) {
      successCount++;
      rtts.push(roundTripMs);
      process.stdout.write(`\r  sent: ${String(successCount).padStart(3)}  rtt: ${String(roundTripMs).padStart(4)}ms  `);
    } else {
      log(''); // newline after \r
      const rawHeader  = response?.headers?.get('retry-after');
      const retryAfterMs = rawHeader ? parseFloat(rawHeader) * 1000 : null;
      return {
        successCount,
        elapsedMs:   Date.now() - startTime,
        retryAfterMs,
        avgRtt:      rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : 0,
        retryAfterResponse: response,
      };
    }
  }
}

async function testRequestsPerWindow() {
  log('═══════════════════════════════════════════════════════');
  log('TEST A — Requests-per-window ceiling');
  log(`         (${TRIAL_COUNT} independent trials, each starting from a clean window)`);
  log('═══════════════════════════════════════════════════════\n');

  const trials = [];

  for (let trial = 1; trial <= TRIAL_COUNT; trial++) {
    log(`── Trial ${trial}/${TRIAL_COUNT} ──`);
    await waitUntilReady(` trial ${trial}`);

    const result = await burstUntil429(0);
    const { successCount, elapsedMs, retryAfterMs, avgRtt, retryAfterResponse } = result;

    log(`  ✓ succeeded: ${successCount}  elapsed: ${fmt(elapsedMs)}  avg-rtt: ${avgRtt}ms`);
    if (retryAfterMs) log(`  Retry-After: ${fmt(retryAfterMs)}`);

    trials.push({ successCount, elapsedMs, retryAfterMs });

    if (trial < TRIAL_COUNT) {
      await coolDown(retryAfterResponse, ` (trial ${trial} done)`);
    }

    log('');
  }

  const counts       = trials.map((t) => t.successCount);
  const minCount     = Math.min(...counts);
  const maxCount     = Math.max(...counts);
  const avgCount     = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
  const retryAfters  = trials.map((t) => t.retryAfterMs).filter(Boolean);
  const avgRetryMs   = retryAfters.length
    ? Math.round(retryAfters.reduce((a, b) => a + b, 0) / retryAfters.length)
    : null;

  log('── Test A Summary ──');
  log(`  Counts per trial:        ${counts.join(', ')}`);
  log(`  Min / Avg / Max:         ${minCount} / ${avgCount} / ${maxCount}`);
  if (avgRetryMs) log(`  Avg Retry-After:         ${fmt(avgRetryMs)}`);
  const windowSec = avgRetryMs ? Math.round(avgRetryMs / 1000) : 60;
  log(`  Estimated window:        ~${windowSec}s`);
  log(`  Safe budget (min - 1):   ${minCount - 1} requests per ~${windowSec}s window`);

  return { minCount, avgCount, maxCount, windowSec };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST B — does spacing within the window matter?
// ═══════════════════════════════════════════════════════════════════════════

async function testSpacingMatters(windowBudget, windowSec) {
  log('\n═══════════════════════════════════════════════════════');
  log('TEST B — Does inter-request spacing matter?');
  log('═══════════════════════════════════════════════════════');

  // Use (windowBudget + 2) requests to intentionally exceed the limit.
  // Hypothesis: if spacing doesn't matter, both styles fail at the same count.
  const targetCount = windowBudget + 2;
  const spacedDelay = Math.floor((windowSec * 1000) / targetCount);

  log(`  Will attempt ${targetCount} requests (${windowBudget - 1} = known safe budget + buffer)`);
  log(`  Spaced delay: ${fmt(spacedDelay)} per request (evenly across ${windowSec}s window)\n`);

  // ── Strategy 1: no delay ──
  log('Strategy 1: no delay (burst)');
  await waitUntilReady(' burst');
  const burstResult = await burstUntil429(0);
  log(`  succeeded: ${burstResult.successCount}  elapsed: ${fmt(burstResult.elapsedMs)}`);
  await coolDown(burstResult.retryAfterResponse, ' (burst done)');
  log('');

  // ── Strategy 2: evenly spaced ──
  log(`Strategy 2: evenly spaced (${fmt(spacedDelay)} between requests)`);
  await waitUntilReady(' spaced');
  const spacedResult = await burstUntil429(spacedDelay);
  log(`  succeeded: ${spacedResult.successCount}  elapsed: ${fmt(spacedResult.elapsedMs)}`);
  if (spacedResult.retryAfterResponse) {
    await coolDown(spacedResult.retryAfterResponse, ' (spaced done)');
  }
  log('');

  log('── Test B Summary ──');
  log(`  Burst (0ms delay):              ${burstResult.successCount} requests before 429`);
  log(`  Spaced (${fmt(spacedDelay)} delay):          ${spacedResult.successCount} requests before 429`);

  const spacingMatters = spacedResult.successCount > burstResult.successCount + 1;
  if (spacingMatters) {
    log('  ✓ Spacing DOES matter — evenly distributing requests extends the budget.');
  } else {
    log('  ✗ Spacing does NOT matter — the limit is purely count-based per time window.');
  }

  return {
    burstCount:  burstResult.successCount,
    spacedCount: spacedResult.successCount,
    spacingMatters,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log('=== MediaWiki API rate-limit probe (request-rate edition) ===\n');

  const { minCount, avgCount, windowSec } = await testRequestsPerWindow();

  log(`\nCooling down before Test B...`);
  await sleep(3000);

  const { burstCount, spacedCount, spacingMatters } = await testSpacingMatters(minCount, windowSec);

  log('\n════════════════════════════════════════════════════════');
  log('FINAL RESULTS');
  log('════════════════════════════════════════════════════════');
  log(`  Requests allowed per ~${windowSec}s window:`);
  log(`    Min observed:    ${minCount}`);
  log(`    Avg observed:    ${avgCount}`);
  log(`  Spacing matters:   ${spacingMatters ? 'YES — spread requests across the window' : 'NO — only total count per window matters'}`);
  log('');
  log('Recommendation for wiki_searcher/index.js:');

  const safeCount = minCount - 1;
  const delayMs   = Math.ceil((windowSec * 1000) / safeCount);
  log(`  • Budget:  ${safeCount} requests per ${windowSec}s window`);
  log(`  • Use sequential requests with at least ${fmt(delayMs)} between each`);
  log(`    (evenly distributes ${safeCount} requests over the ${windowSec}s window)`);
  if (!spacingMatters) {
    log(`  • Since spacing doesn't matter, you can also batch them:`);
    log(`    fire up to ${safeCount} sequentially, then sleep ~${windowSec}s before the next batch.`);
  }
}

main().catch((error) => {
  log(`\nFatal error: ${error.message}`);
  process.exit(1);
});
