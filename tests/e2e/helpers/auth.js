import crypto from 'crypto';

export function uniqueUsername(prefix = 'user') {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Creates a real account through the actual signup endpoint (not a DB
 * shortcut — this one's cheap and fast enough as-is, and going through the
 * real endpoint means every test that needs "a logged-in user" also
 * incidentally re-verifies signup wiring). Uses `page.request`, which shares
 * the browser context's cookie jar, so a subsequent `page.goto(...)` is
 * already authenticated — no UI form-filling needed for tests that aren't
 * specifically about the signup form itself (see auth.spec.js for those).
 */
export async function signupViaApi(page, overrides = {}) {
  const username = overrides.username ?? uniqueUsername();
  const password = overrides.password ?? 'correct-horse-battery-staple';
  const email = overrides.email ?? `${username}@example.test`;
  const displayName = overrides.displayName ?? username;

  const response = await page.request.post('/api/account/signup', {
    data: { username, email, password, displayName },
  });
  if (!response.ok()) {
    throw new Error(`signupViaApi failed: ${response.status()} ${await response.text()}`);
  }
  const { user } = await response.json();
  return { user, username, password, email, displayName };
}
