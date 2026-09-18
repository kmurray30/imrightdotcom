// Feature area A — Header / global nav (see FEATURE_CHECKLIST.md #1-6).
import { test, expect } from '@playwright/test';
import { signupViaApi } from './helpers/auth.js';

test.describe('Header / nav', () => {
  test('A1: logo links back to home', async ({ page }) => {
    await page.goto('/history');
    await page.getByRole('link', { name: 'imright.com' }).click();
    await expect(page).toHaveURL('/');
  });

  test('A2: History link is visible to a guest', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
  });

  test('A5: guest sees Log in / Sign up links, not Log out', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });

  test('A3+A4: Bookmarks and profile links are hidden for a guest', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Bookmarks' })).toHaveCount(0);
    // No account yet, so there is no profile-name link at all for a guest.
    await expect(page.locator('.site-nav a[href^="/u/"]')).toHaveCount(0);
  });

  test('A3+A4+A6: logged-in user sees Bookmarks + profile link, and Log out works', async ({ page }) => {
    const { displayName, username } = await signupViaApi(page);
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Bookmarks' })).toBeVisible();
    const profileLink = page.locator('.site-nav a', { hasText: displayName });
    await expect(profileLink).toBeVisible();
    await expect(profileLink).toHaveAttribute('href', `/u/${username}`);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bookmarks' })).toHaveCount(0);
  });
});
