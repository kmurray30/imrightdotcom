// Feature area E — Auth: signup, login, logout (see FEATURE_CHECKLIST.md #42-46).
import { test, expect } from '@playwright/test';
import { signupViaApi, uniqueUsername } from './helpers/auth.js';
import { seedArticle } from './helpers/db.js';

test.describe('Signup', () => {
  test('E42: rejects a duplicate username with a clear error', async ({ page, browser }) => {
    const { username } = await signupViaApi(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto('/signup');
    await page2.getByLabel('Username').fill(username);
    await page2.getByLabel('Display name').fill('Someone Else');
    await page2.getByLabel('Email').fill(`${uniqueUsername()}@example.test`);
    await page2.getByLabel('Password').fill('another-strong-password');
    await page2.getByRole('button', { name: 'Sign up' }).click();
    await expect(page2.locator('.form-error')).toHaveText('That username is already taken.');
    await context2.close();
  });

  test('E42: rejects a duplicate email with a clear error', async ({ page, browser }) => {
    const { email } = await signupViaApi(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto('/signup');
    await page2.getByLabel('Username').fill(uniqueUsername());
    await page2.getByLabel('Email').fill(email);
    await page2.getByLabel('Password').fill('another-strong-password');
    await page2.getByRole('button', { name: 'Sign up' }).click();
    await expect(page2.locator('.form-error')).toHaveText('That email is already registered.');
    await context2.close();
  });

  test('E42: rejects signing up again while already logged in', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/signup');
    await page.getByLabel('Username').fill(uniqueUsername());
    await page.getByLabel('Email').fill(`${uniqueUsername()}@example.test`);
    await page.getByLabel('Password').fill('another-strong-password');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.locator('.form-error')).toHaveText("You're already logged in.");
  });

  test('E42: the username field enforces a safe character/length pattern client-side', async ({ page }) => {
    await page.goto('/signup');
    const usernameInput = page.getByLabel('Username');
    await expect(usernameInput).toHaveAttribute('pattern', '[a-zA-Z0-9_\\-]+');
    await expect(usernameInput).toHaveAttribute('minlength', '3');
    await expect(usernameInput).toHaveAttribute('maxlength', '20');
  });

  test('E43: a successful signup logs the user in, redirects home, and carries over prior guest history', async ({
    page,
  }) => {
    // Establishes a guest identity the same way the real app does: POST
    // /api/run calls ensureOwner (minting the guest row + cookie) before the
    // pipeline itself runs — the pipeline then fails on the network call
    // this sandbox can't make, which is fine, since this test only needs the
    // guest identity, not a real generated article.
    await page.request.post('/api/run', { data: { claim: 'a guest claim before signup' } });
    const me = await (await page.request.get('/api/account/me')).json();
    expect(me.user?.isGuest).toBe(true);

    await seedArticle({ ownerUserId: me.user.id, claim: 'pre-signup guest article' });

    const username = uniqueUsername();
    await page.goto('/signup');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Display name').fill('Carryover Test');
    await page.getByLabel('Email').fill(`${username}@example.test`);
    await page.getByLabel('Password').fill('correct-horse-battery-staple');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('.site-nav a', { hasText: 'Carryover Test' })).toBeVisible();

    await page.goto('/history');
    await expect(page.locator('.history-list')).toContainText('pre-signup guest article');
  });
});

test.describe('Login / logout', () => {
  test('E44+E45: valid credentials log in and update the header', async ({ page }) => {
    const { username, password, displayName } = await signupViaApi(page);
    await page.request.post('/api/account/logout');

    await page.goto('/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('.site-nav a', { hasText: displayName })).toBeVisible();
  });

  test('E44: wrong password shows "wrong username or password"', async ({ page }) => {
    const { username } = await signupViaApi(page);
    await page.request.post('/api/account/logout');

    await page.goto('/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('definitely-not-it');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('.form-error')).toHaveText('Wrong username or password.');
  });

  test('E44: an account locks out after repeated failed attempts', async ({ page }) => {
    const { username } = await signupViaApi(page);
    await page.request.post('/api/account/logout');

    for (let i = 0; i < 8; i++) {
      await page.request.post('/api/account/login', { data: { username, password: 'wrong-again' } });
    }

    await page.goto('/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('wrong-again');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('.form-error')).toHaveText('Too many failed attempts — try again in a few minutes.');
  });

  test('E46: logging out clears the session and reverts the header to guest state', async ({ page }) => {
    const { displayName } = await signupViaApi(page);
    await page.goto('/');
    await expect(page.locator('.site-nav a', { hasText: displayName })).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();

    const me = await (await page.request.get('/api/account/me')).json();
    expect(me.user === null || me.user.isGuest).toBe(true);
  });
});
