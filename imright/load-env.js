import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Load env vars from the first of env.local or .env found in PROJECT_ROOT.
 * Existing process.env keys are not overwritten.
 * Shared by the CLI (imright/cli.js) and the site server (imright/scripts/serve-site.js).
 */
export function loadEnv() {
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
            let value = trimmed.slice(eqIndex + 1).trim();
            const isQuoted =
              value.length >= 2 &&
              ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
            if (isQuoted) value = value.slice(1, -1);
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
      break;
    }
  }
}
