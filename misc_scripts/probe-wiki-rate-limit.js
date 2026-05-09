#!/usr/bin/env node
/**
 * Finds the MediaWiki API concurrent-request rate limit via two phases:
 *
 *   Phase 1 – Exponential growth from 1 upward (1, 2, 4, 8, …) until the
 *             first 429. This quickly narrows the boundary range without
 *             wasting time on levels that are obviously too high.
 *
 *   Phase 2 – Binary search inside [lastSafe, firstFail] with multi-round
 *             validation, but only on SAFE candidates (avoids paying the
 *             Retry-After penalty repeatedly on clearly-failing levels).
 *
 * Strategy for 429 handling:
 *   - A single failed request is enough to classify a level as FAIL; we
 *     don't run more rounds on it (no point burning Retry-After waits).
 *   - When we do get rate-limited, we honour the Retry-After header before
 *     continuing.
 *   - SAFE validation requires ROUNDS consecutive clean rounds.
 *
 * Usage:  node misc_scripts/probe-wiki-rate-limit.js
 */

const WIKI_API    = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT  = 'imright-rate-probe/1.0 (educational research)';
const PROBE_QUERY = 'history';

// How many clean rounds required to call a level "confirmed safe".
const ROUNDS = 5;

// Pause between rounds at the same level.
const ROUND_DELAY_MS = 1200;

// Pause between distinct concurrency levels (lets the server breathe).
const STEP_DELAY_MS = 2000;

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

/**
 * Honour the Retry-After header from a 429 response.
 * Falls back to `defaultMs` when the header is absent.
 */
async function respectRetryAfter(response, defaultMs = 8000) {
  const rawHeader = response?.headers?.get('retry-after');
  const seconds   = rawHeader ? parseFloat(rawHeader) : NaN;
  const waitMs    = isNaN(seconds) ? defaultMs : Math.ceil(seconds * 1000) + 500;
  log(`  ⏳ Retry-After: ${rawHeader ?? 'n/a'} → waiting ${(waitMs / 1000).toFixed(1)}s`);
  await sleep(waitMs);
}

/**
 * Fire `count` identical requests simultaneously.
 * Resolves immediately — does NOT wait for Retry-After here.
 *
 * Returns { successes, rateLimited, errors, retryAfterResponse }
 */
async function fireRequests(count) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', PROBE_QUERY);
  url.searchParams.set('srlimit', '1');
  url.searchParams.set('format', 'json');
  const urlString = url.toString();

  const settled = await Promise.all(
    Array.from({ length: count }, () =>
      fetch(urlString, { headers: { 'User-Agent': USER_AGENT } })
        .then((response) => ({ status: response.status, response }))
        .catch((error)    => ({ status: 'network_error', error: error.message, response: null }))
    )
  );

  let successes          = 0;
  let rateLimited        = 0;
  let errors             = 0;
  let retryAfterResponse = null;

  for (const item of settled) {
    if (item.status === 200)      successes++;
    else if (item.status === 429) { rateLimited++; retryAfterResponse ??= item.response; }
    else                          errors++;
  }

  return { successes, rateLimited, errors, retryAfterResponse };
}

/**
 * Quick single-shot check: returns true if concurrency level passes (no 429),
 * false otherwise. Honours Retry-After on failure.
 */
async function quickCheck(concurrency) {
  const { rateLimited, errors, retryAfterResponse } = await fireRequests(concurrency);
  const passed = rateLimited === 0 && errors === 0;
  if (!passed && rateLimited > 0) await respectRetryAfter(retryAfterResponse);
  return passed;
}

/**
 * Run ROUNDS probes at `concurrency`, aborting early on ANY failure.
 * Returns { safe: boolean, passedRounds: number }
 */
async function validateSafe(concurrency) {
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) await sleep(ROUND_DELAY_MS);

    const { rateLimited, errors, retryAfterResponse } = await fireRequests(concurrency);
    const passed = rateLimited === 0 && errors === 0;
    const badge  = passed ? '✓' : `✗ (${rateLimited} limited, ${errors} err)`;
    log(`  round ${round}/${ROUNDS}: ${badge}`);

    if (!passed) {
      if (rateLimited > 0) await respectRetryAfter(retryAfterResponse);
      return { safe: false, passedRounds: round - 1 };
    }
  }
  return { safe: true, passedRounds: ROUNDS };
}

/**
 * Wait until the API accepts single requests before we start probing.
 */
async function waitUntilUnblocked() {
  process.stdout.write('Checking API availability...');
  let attempt = 0;
  while (true) {
    attempt++;
    const { successes, rateLimited, retryAfterResponse } = await fireRequests(1);
    if (successes === 1) { log(' ready\n'); return; }
    process.stdout.write(` 429 (attempt ${attempt})`);
    await respectRetryAfter(retryAfterResponse, 10000);
  }
}

// ─── Phase 1: exponential growth ────────────────────────────────────────────

/**
 * Doubles concurrency from 1 until the first 429.
 * Returns { lastSafe, firstFail } — the boundary bracket.
 */
async function exponentialGrowth() {
  log('── Phase 1: exponential growth ──');
  let lastSafe  = null;
  let current   = 1;

  while (true) {
    log(`\nTrying concurrency = ${current}`);
    const passed = await quickCheck(current);

    if (passed) {
      log(`  → safe`);
      lastSafe = current;
      const next = current * 2;
      await sleep(STEP_DELAY_MS);
      current = next;
    } else {
      log(`  → rate-limited`);
      const firstFail = current;
      if (lastSafe === null) {
        // Even 1 was rate-limited — something external is wrong.
        log('\nCould not establish a safe baseline (even 1 request was rate-limited).');
        log('Check your IP / wait longer and re-run.');
        process.exit(1);
      }
      log(`\nBoundary bracket: [${lastSafe}, ${firstFail}]`);
      return { lastSafe, firstFail };
    }
  }
}

// ─── Phase 2: binary search ──────────────────────────────────────────────────

/**
 * Binary-search within [low, high] for the exact safe ceiling.
 * Uses quick-check for FAIL candidates (no multi-round waste),
 * and full validation for SAFE candidates.
 *
 * Returns { highestSafe, lowestFail }
 */
async function binarySearch(low, high) {
  log('\n── Phase 2: binary search ──');

  let highestSafe = low;   // we know `low` is safe from Phase 1
  let lowestFail  = high;  // we know `high` is fail from Phase 1

  let searchLow  = low + 1;  // low itself is already confirmed safe
  let searchHigh = high - 1; // high itself is already confirmed fail

  while (searchLow <= searchHigh) {
    const mid = Math.floor((searchLow + searchHigh) / 2);
    log(`\nProbing concurrency = ${mid}  (range [${searchLow}, ${searchHigh}])`);

    await sleep(STEP_DELAY_MS);

    // Quick pre-check to avoid multi-round waste on clearly-failing levels.
    const preCheck = await quickCheck(mid);
    if (!preCheck) {
      log(`  → pre-check failed → FAIL`);
      lowestFail = mid;
      searchHigh = mid - 1;
      continue;
    }

    // Level passed the quick check — now validate with full ROUNDS.
    log(`  Pre-check passed — running ${ROUNDS}-round validation:`);
    const { safe } = await validateSafe(mid);

    if (safe) {
      log(`  → SAFE`);
      highestSafe = Math.max(highestSafe, mid);
      searchLow   = mid + 1;
    } else {
      log(`  → FAIL`);
      lowestFail  = Math.min(lowestFail, mid);
      searchHigh  = mid - 1;
    }
  }

  return { highestSafe, lowestFail };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('=== MediaWiki API concurrent-request rate-limit probe ===\n');
  log(`Validation: ${ROUNDS} clean rounds required to confirm safe`);
  log(`Delays:     ${ROUND_DELAY_MS}ms between rounds, ${STEP_DELAY_MS}ms between levels\n`);

  await waitUntilUnblocked();

  const { lastSafe, firstFail } = await exponentialGrowth();

  let highestSafe;
  let lowestFail;

  if (firstFail - lastSafe === 1) {
    // Boundary is already exact — no binary search needed.
    log('\nBoundary is already exact (no gap to search).');
    highestSafe = lastSafe;
    lowestFail  = firstFail;
  } else {
    ({ highestSafe, lowestFail } = await binarySearch(lastSafe, firstFail));
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  log('\n════════════════════════════════════════');
  log('RESULTS');
  log('════════════════════════════════════════');
  log(`  Highest confirmed-safe concurrency:  ${highestSafe}`);
  log(`  Lowest confirmed-fail concurrency:   ${lowestFail}`);
  log(`  Recommended limit (with headroom):   ${Math.max(1, highestSafe - 1)}`);
  log('');
  log(`  In wiki_searcher/index.js, replace Promise.all with a`);
  log(`  concurrency-limited pool capped at ${Math.max(1, highestSafe - 1)}.`);
}

main().catch((error) => {
  log(`\nFatal error: ${error.message}`);
  process.exit(1);
});
