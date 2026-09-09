/**
 * Persists whether the main site's password gate is on/off and the hash of
 * the current site password. Read fresh on every request (same pattern as
 * config/app_config.json in serve-site.js) so a change made from /admin
 * takes effect immediately, no restart needed.
 *
 * Lives outside git (see .gitignore) since it holds a password hash and is
 * mutated at runtime. Note: on Railway without a persistent volume mounted
 * at this path, the file resets to DEFAULT_STATE on every redeploy — attach
 * a volume there if the toggle/password should survive deploys.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SITE_LOCK_PATH = path.join(PROJECT_ROOT, 'data', 'site_lock.json');

// No password configured yet: the site starts open rather than locked with
// no working password, until an admin sets one from /admin.
const DEFAULT_STATE = { passwordProtectionEnabled: false, passwordHash: null };

export function readSiteLock() {
  try {
    const raw = fs.readFileSync(SITE_LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      passwordProtectionEnabled: Boolean(parsed.passwordProtectionEnabled),
      passwordHash: typeof parsed.passwordHash === 'string' ? parsed.passwordHash : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeSiteLock(nextState) {
  const current = readSiteLock();
  const merged = { ...current, ...nextState };
  fs.mkdirSync(path.dirname(SITE_LOCK_PATH), { recursive: true });
  fs.writeFileSync(SITE_LOCK_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
