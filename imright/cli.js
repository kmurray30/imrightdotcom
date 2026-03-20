#!/usr/bin/env node
/**
 * CLI for imright: runs the full pipeline from claim to tabloid HTML.
 *
 * Usage: node imright/cli.js "<claim>"
 *   or:  echo "<claim>" | node imright/cli.js
 *
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Outputs: conspirator/conspiracies/, wiki_searcher/wikis-fetched/, wiki_filterer/wikis-filtered/,
 *          article_extractor/extracted/, tabloid_generator/output/
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { runPipeline } from './index.js';

/** Open file in default browser (macOS: open, Windows: start, Linux: xdg-open). */
function openInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const command =
    process.platform === 'darwin'
      ? `open "${absolutePath}"`
      : process.platform === 'win32'
        ? `start "" "${absolutePath}"`
        : `xdg-open "${absolutePath}"`;
  exec(command, (err) => {
    if (err) console.error('Could not open in browser:', err.message);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  for (const filename of ['env.local', '.env']) {
    const envPath = path.join(PROJECT_ROOT, filename);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
      break;
    }
  }
}

loadEnv();

async function getClaimFromArgs() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.join(' ');
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
  const claim = await getClaimFromArgs();
  if (!claim) {
    console.error('Usage: node imright/cli.js "<claim>"');
    console.error('   or: echo "<claim>" | node imright/cli.js');
    process.exit(1);
  }

  const rows = [];
  const widths = [6, 38, 14, 15, 8, 10]; // stage, name, input, output, cost, time
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

  const onProgress = (step, total, message) => {
    if (!isTty) return; // Non-TTY: only print full rows in onStepComplete
    if (rows.length >= step) return; // Already past this step
    const stageStr = `${step}/${total}`;
    const nameStr = message.slice(0, widths[1]);

    if (rows.length === 0) {
      console.error(borderRow());
      console.error(dataRow(['Stage', 'Name', 'Input tokens', 'Output tokens', 'Cost', 'Time']));
      console.error(borderRow());
    }

    const pending = '...';
    console.error(
      dataRow([stageStr, nameStr, pending, pending, pending, pending], [2, 3, 4, 5])
    );
  };

  const onStepComplete = (step, total, message, delta) => {
    const row = {
      stage: `${step}/${total}`,
      name: message,
      inputTokens: delta?.inputTokens ?? 0,
      outputTokens: delta?.outputTokens ?? 0,
      cost: delta?.totalCost ?? 0,
      timeMs: delta?.timeMs ?? 0,
    };
    rows.push(row);

    const nameDisplay = row.name.replace(/\.\.\.$/, '').slice(0, widths[1]);
    const timeStr = row.timeMs >= 1000 ? `${(row.timeMs / 1000).toFixed(2)}s` : `${Math.round(row.timeMs)}ms`;
    const fullRow = dataRow(
      [
        row.stage,
        nameDisplay,
        row.inputTokens.toLocaleString(),
        row.outputTokens.toLocaleString(),
        `${(row.cost * 100).toFixed(2)}¢`,
        timeStr,
      ],
      [2, 3, 4, 5]
    );

    if (isTty) {
      process.stderr.write(CURSOR_UP + CLEAR_LINE + CARRIAGE_RETURN + fullRow + '\n');
    } else {
      if (rows.length === 1) {
        console.error(borderRow());
        console.error(dataRow(['Stage', 'Name', 'Input tokens', 'Output tokens', 'Cost', 'Time']));
        console.error(borderRow());
      }
      console.error(fullRow);
    }
  };

  const result = await runPipeline(claim, { onProgress, onStepComplete });

  const outputPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${result.slug}.html`);

  const totalInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const totalTimeMs = rows.reduce((sum, row) => sum + row.timeMs, 0);
  const totalTimeStr = totalTimeMs >= 1000 ? `${(totalTimeMs / 1000).toFixed(2)}s` : `${Math.round(totalTimeMs)}ms`;

  console.error(borderRow());
  console.error(
    dataRow(['Total', '', totalInput.toLocaleString(), totalOutput.toLocaleString(), `${(totalCost * 100).toFixed(2)}¢`, totalTimeStr], [2, 3, 4, 5])
  );
  console.error(borderRow());

  console.error(`\nDone. Output: tabloid_generator/output/${result.slug}.html`);

  openInBrowser(outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
