#!/usr/bin/env node
/**
 * CLI for imright: runs the full pipeline from claim to tabloid HTML.
 *
 * Usage: node imright/cli.js "<claim>"
 *   or:  echo "<claim>" | node imright/cli.js
 *   or:  node imright/cli.js "<claim>" --regenerate   # Skip pipeline, just rebuild HTML + debug
 *
 * Options:
 *   --regenerate, -r   Only regenerate final HTML and debug HTML from existing data (no Grok calls).
 *                      Requires output_raw and extracted to exist for the slug.
 *
 * Requires: XAI_API_KEY in environment (or env.local in project root) for full pipeline
 * Outputs: conspirator/conspiracies/, wiki_searcher/wikis-fetched/, wiki_filterer/wikis-filtered/,
 *          ref_extractor/extracted/, tabloid_generator/output/
 */

import fs from 'fs';
import path from 'path';
import { exec, execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { runPipeline, regenerateHtmlOnly } from './index.js';
import { slugify } from './utils.js';
import { loadEnv } from './load-env.js';

/** Open file or URL in default browser (macOS: open, Windows: start, Linux: xdg-open). */
function openInBrowser(filePathOrUrl) {
  const target = filePathOrUrl.startsWith('http')
    ? filePathOrUrl
    : path.resolve(filePathOrUrl);
  const command =
    process.platform === 'darwin'
      ? `open "${target}"`
      : process.platform === 'win32'
        ? `start "" "${target}"`
        : `xdg-open "${target}"`;
  exec(command, (err) => {
    if (err) console.error('Could not open in browser:', err.message);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

loadEnv();

function parseArgs() {
  const raw = process.argv.slice(2);
  const flags = { regenerate: false };
  const nonFlags = [];

  for (const arg of raw) {
    if (arg === '--regenerate' || arg === '-r') {
      flags.regenerate = true;
    } else {
      nonFlags.push(arg);
    }
  }

  return { flags, rest: nonFlags };
}

async function getClaimFromArgs(restArgs) {
  if (restArgs.length > 0) {
    return restArgs.join(' ');
  }
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => resolve(input.trim()));
      process.stdin.on('error', reject);
    });
  }
  return null;
}

async function main() {
  const { flags, rest } = parseArgs();
  const claim = await getClaimFromArgs(rest);
  if (!claim) {
    console.error('Usage: node imright/cli.js "<claim>"');
    console.error('   or: echo "<claim>" | node imright/cli.js');
    console.error('   or: node imright/cli.js "<claim>" --regenerate  (regenerate HTML only, skip pipeline)');
    process.exit(1);
  }

  const slug = slugify(claim);

  if (flags.regenerate) {
    try {
      const result = await regenerateHtmlOnly(slug);
      const outputPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${result.slug}.html`);
      console.error(`Regenerated: tabloid_generator/output/${result.slug}.html`);
      console.error(`Debug page: imright/debug/${result.slug}.html`);
      openInBrowser(outputPath);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
    return;
  }

  const rows = [];
  const widths = [6, 38, 14, 15, 8, 10, 8]; // stage, name, input, output, cost, time, retries
  const pad = (value, width) => String(value).padEnd(width);
  const padNum = (value, width) => String(value).padStart(width);
  const isTty = process.stderr.isTTY;
  const CURSOR_UP = '\x1b[1A';
  const CLEAR_LINE = '\x1b[2K';
  const CARRIAGE_RETURN = '\r';

  const borderRow = () => '+' + widths.map((w) => '-'.repeat(w)).join('+') + '+';
  const dataRow = (cells, numericIndices = []) => {
    const formatted = cells.map((cell, index) =>
      numericIndices.includes(index) ? padNum(cell, widths[index]) : pad(cell, widths[index])
    );
    return '|' + formatted.join('|') + '|';
  };

  // Track if we have a pending "..." row on screen (same line, no newline) so we can overwrite it
  let hasPendingRow = false;

  const onProgress = (step, total, message) => {
    if (!isTty) return;
    if (rows.length >= step) return;
    const stageStr = `${step}/${total}`;
    const nameStr = message.slice(0, widths[1]);

    if (rows.length === 0) {
      console.error(borderRow());
      console.error(dataRow(['Stage', 'Name', 'Input tokens', 'Output tokens', 'Cost', 'Time', 'Retries']));
      console.error(borderRow());
    }

    const pending = '...';
    const pendingRow = dataRow([stageStr, nameStr, pending, pending, pending, pending, pending], [2, 3, 4, 5, 6]);
    process.stderr.write(pendingRow);
    hasPendingRow = true;
  };

  const onStepComplete = (step, total, message, delta) => {
    const row = {
      stage: `${step}/${total}`,
      name: message,
      inputTokens: delta?.inputTokens ?? 0,
      outputTokens: delta?.outputTokens ?? 0,
      cost: delta?.totalCost ?? 0,
      timeMs: delta?.timeMs ?? 0,
      retries: delta?.retries ?? '',
    };
    rows.push(row);

    const nameDisplay = row.name.replace(/\.\.\.$/, '').slice(0, widths[1]);
    const timeStr = row.timeMs >= 1000 ? `${(row.timeMs / 1000).toFixed(2)}s` : `${Math.round(row.timeMs)}ms`;
    const retriesStr = row.retries !== '' ? String(row.retries) : '';
    const fullRow = dataRow(
      [
        row.stage,
        nameDisplay,
        row.inputTokens.toLocaleString(),
        row.outputTokens.toLocaleString(),
        `${(row.cost * 100).toFixed(2)}¢`,
        timeStr,
        retriesStr,
      ],
      [2, 3, 4, 5, 6]
    );

    if (isTty) {
      if (hasPendingRow) {
        hasPendingRow = false;
        process.stderr.write(CARRIAGE_RETURN + CLEAR_LINE + fullRow + '\n');
      } else {
        process.stderr.write(CURSOR_UP + CLEAR_LINE + CARRIAGE_RETURN + fullRow + '\n');
      }
    } else {
      if (rows.length === 1) {
        console.error(borderRow());
        console.error(dataRow(['Stage', 'Name', 'Input tokens', 'Output tokens', 'Cost', 'Time', 'Retries']));
        console.error(borderRow());
      }
      console.error(fullRow);
    }
  };

  const SERVE_PORT = 3757;
  const outputPathForClaim = (slug) =>
    path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`);

  // Kill any leftover server on our port
  try { execSync(`lsof -ti:${SERVE_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' }); } catch {}

  // Start HTTP server and wait for it to be ready (reads URL from stdout).
  // Once we have the URL we destroy the pipes so they don't keep the parent alive.
  const serveBaseUrl = await new Promise((resolve) => {
    const child = spawn(
      'node',
      ['imright/scripts/serve-output.js', String(SERVE_PORT)],
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );
    child.unref();

    const detachPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const timeout = setTimeout(() => {
      console.error('Warning: HTTP server failed to start, falling back to file://');
      detachPipes();
      resolve(null);
    }, 3000);
    child.stdout.on('data', (chunk) => {
      const url = chunk.toString().trim();
      if (url.startsWith('http')) {
        clearTimeout(timeout);
        detachPipes();
        resolve(url);
      }
    });
    child.on('error', () => { clearTimeout(timeout); detachPipes(); resolve(null); });
  });

  const result = await runPipeline(claim, {
    onProgress,
    onStepComplete,
    onPageReady: (slug) => {
      const url = serveBaseUrl
        ? `${serveBaseUrl}/tabloid_generator/output/${slug}.html`
        : outputPathForClaim(slug);
      openInBrowser(url);
    },
  });

  const outputPath = outputPathForClaim(result.slug);

  const totalInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const totalTimeMs = rows.reduce((sum, row) => sum + row.timeMs, 0);
  const totalTimeStr = totalTimeMs >= 1000 ? `${(totalTimeMs / 1000).toFixed(2)}s` : `${Math.round(totalTimeMs)}ms`;

  const totalRetries = rows.find((r) => r.retries !== '')?.retries ?? 0;
  console.error(borderRow());
  console.error(
    dataRow(['Total', '', totalInput.toLocaleString(), totalOutput.toLocaleString(), `${(totalCost * 100).toFixed(2)}¢`, totalTimeStr, totalRetries], [2, 3, 4, 5, 6])
  );
  console.error(borderRow());

  console.error(`\nDone.`);
  console.error(`Output: tabloid_generator/output/${result.slug}.html`);
  console.error(`Debug: imright/debug/${result.slug}.html`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
