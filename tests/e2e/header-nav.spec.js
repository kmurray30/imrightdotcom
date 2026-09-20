// Feature area A — Header / global nav (see FEATURE_CHECKLIST.md #1-6).
//
// All nav options live behind a single "Menu" dropdown (folded together per
// a real request — the previous flat row of links had no responsive
// handling at all and overlapped/ran off-screen on a phone-width viewport).
import { test, expect } from '@playwright/test';
import { signupViaApi } from './helpers/auth.js';
import { openMenu } from './helpers/nav.js';

test.describe('Header / nav', () => {
  test('A1: logo links back to home', async ({ page }) => {
    await page.goto('/history');
    await page.getByRole('link', { name: 'imright.com' }).click();
    await expect(page).toHaveURL('/');
  });

  test('A2: History link is visible to a guest, inside the menu', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
  });

  test('A5: guest sees Log in / Sign up in the menu, not Log out', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });

  test('A3+A4: Bookmarks and profile links are hidden for a guest', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Bookmarks' })).toHaveCount(0);
    await expect(page.locator('.site-nav-dropdown a[href^="/u/"]')).toHaveCount(0);
  });

  test('A3+A4+A6: logged-in user sees Bookmarks + profile link, and Log out works', async ({ page }) => {
    const { displayName, username } = await signupViaApi(page);
    await page.goto('/');
    await openMenu(page);

    await expect(page.getByRole('link', { name: 'Bookmarks' })).toBeVisible();
    const profileLink = page.locator('.site-nav-dropdown a', { hasText: displayName });
    await expect(profileLink).toBeVisible();
    await expect(profileLink).toHaveAttribute('href', `/u/${username}`);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/');
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bookmarks' })).toHaveCount(0);
  });

  test('A5/A6: a guest sees a hamburger icon; a logged-in user sees a circular avatar with their initial', async ({
    page,
  }) => {
    // Real report: "'menu' is ugly" — a plain hamburger for guests (still
    // exists), but a logged-in user now gets a small circular profile icon
    // instead of the same generic hamburger/text.
    await page.goto('/');
    await expect(page.locator('.nav-toggle-icon')).toBeVisible();
    await expect(page.locator('.nav-toggle-avatar')).toHaveCount(0);

    const { displayName } = await signupViaApi(page);
    await page.reload();
    await expect(page.locator('.nav-toggle-avatar')).toBeVisible();
    await expect(page.locator('.nav-toggle-avatar')).toHaveText(displayName.charAt(0).toUpperCase());
    await expect(page.locator('.nav-toggle-icon')).toHaveCount(0);
  });

  test('menu closes on an outside click, and after following a link', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(page.locator('.site-nav-dropdown')).toBeVisible();

    await page.locator('.site-logo').click();
    await expect(page.locator('.site-nav-dropdown')).toHaveCount(0);

    await openMenu(page);
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL('/history');
    await expect(page.locator('.site-nav-dropdown')).toHaveCount(0);
  });

  test('mobile viewport: the header never overflows or overlaps (regression for a real bug)', async ({ page }) => {
    // The original flat nav row overlapped its own text and ran links off
    // the right edge of the screen at phone width — confirmed via a real
    // screenshot before this fix. Asserts the header's own content never
    // exceeds the viewport width, and the toggle button stays reachable.
    await page.setViewportSize({ width: 390, height: 844 });
    const { displayName } = await signupViaApi(page);
    await page.goto('/');

    const headerBox = await page.locator('.site-header').boundingBox();
    expect(headerBox.width).toBeLessThanOrEqual(390);

    const toggle = page.getByRole('button', { name: /Menu/ });
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(390);

    await openMenu(page);
    await expect(page.locator('.site-nav-dropdown', { hasText: displayName })).toBeVisible();
  });
});
