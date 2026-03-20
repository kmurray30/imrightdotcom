#!/usr/bin/env node
/**
 * Wrapper to run the debug page generator.
 * Usage: node scripts/generate-debug.js <slug>
 *
 * Delegates to imright/scripts/generate-debug.js (which has yaml dependency).
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'imright', 'scripts', 'generate-debug.js');

const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
