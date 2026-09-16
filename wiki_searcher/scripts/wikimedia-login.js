#!/usr/bin/env node
/**
 * One-time setup: exchange your Wikimedia Enterprise username/password for a
 * refresh token, so the running app never has to store your password.
 *
 * Run this once, then set the printed value as WIKIMEDIA_REFRESH_TOKEN
 * (env.local for local dev, a real Railway env var for prod). After that you
 * can remove WIKIMEDIA_PASSWORD — the app only ever calls token-refresh.
 * Re-run this script to mint a new refresh token when the old one expires
 * (90 days, or 90 refresh calls, whichever comes first).
 *
 * Usage: node wiki_searcher/scripts/wikimedia-login.js
 * (reads WIKIMEDIA_USERNAME/WIKIMEDIA_PASSWORD from env.local/.env or the shell env)
 */
import { loadEnv } from '../../imright/load-env.js';

loadEnv();

const username = process.env.WIKIMEDIA_USERNAME;
const password = process.env.WIKIMEDIA_PASSWORD;

if (!username || !password) {
  console.error('Set WIKIMEDIA_USERNAME and WIKIMEDIA_PASSWORD (env.local or shell env), then re-run.');
  process.exit(1);
}

const response = await fetch('https://auth.enterprise.wikimedia.com/v1/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: username.toLowerCase(), password }),
});

if (!response.ok) {
  console.error(`Login failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const data = await response.json();
console.log('\nLogin succeeded. Set this as WIKIMEDIA_REFRESH_TOKEN:\n');
console.log(data.refresh_token);
console.log('\n(Good for 90 days / 90 refreshes — re-run this script to mint a new one when it expires.)');
