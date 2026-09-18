import { defineConfig, devices } from '@playwright/test';

// Local dev Postgres — same DB the manual debug-loop testing in this repo's
// history has used. Must be reachable and migrated before running tests
// (`npm run migrate`). Exported here so it's set for both this config's own
// process (fixtures in tests/e2e/helpers/db.js talk to Postgres directly)
// and the webServer child process below, from one place.
process.env.DATABASE_URL ||= 'postgresql://postgres:localdev@localhost:5432/imright';

const PORT = 3759;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: '/opt/pw-browsers/chromium',
        },
      },
    },
  ],
  webServer: {
    command: 'node imright/scripts/serve-site.js',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
      SERVE_MODE: 'local',
      PORT: String(PORT),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
