// Feature areas F, G, H — History, Bookmarks, and Profile pages
// (see FEATURE_CHECKLIST.md #47-54).
import { test, expect } from '@playwright/test';
import { signupViaApi } from './helpers/auth.js';
import { seedArticle, seedGuestUser, seedRealUser, uniqueSlug } from './helpers/db.js';

test.describe('History page', () => {
  test('F49: shows an empty state with no history yet', async ({ page }) => {
    await page.goto('/history');
    await expect(page.getByText('Nothing yet — try the idea input on the home page.')).toBeVisible();
  });

  test('F47+F48: guest-ok, lists both public and private articles with a visibility badge, linking to each', async ({
    page,
  }) => {
    const me = await (await page.request.get('/api/account/me')).json();
    expect(me.user).toBeNull(); // brand-new visitor, no identity yet

    // Establishes this browser's guest identity the same way the real app
    // does (see auth.spec.js's E43 for why this is safe to do here).
    await page.request.post('/api/run', { data: { claim: 'history guest claim' } });
    const afterRun = await (await page.request.get('/api/account/me')).json();
    const ownerId = afterRun.user.id;

    const priv = await seedArticle({ ownerUserId: ownerId, claim: `private one ${uniqueSlug('p')}`, isPublic: false });
    const pub = await seedArticle({ ownerUserId: ownerId, claim: `public one ${uniqueSlug('q')}`, isPublic: true });

    await page.goto('/history');
    const privRow = page.locator('li', { hasText: 'private one' });
    const pubRow = page.locator('li', { hasText: 'public one' });
    await expect(privRow.locator('.visibility-badge')).toHaveText('Private');
    await expect(pubRow.locator('.visibility-badge')).toHaveText('Public');
    await expect(privRow.locator('a')).toHaveAttribute('href', priv.url);
    await expect(pubRow.locator('a')).toHaveAttribute('href', pub.url);
  });
});

test.describe('Bookmarks page', () => {
  test('G51: shows an empty state with no folders yet', async ({ page }) => {
    await signupViaApi(page);
    await page.goto('/bookmarks');
    await expect(page.getByText('No folders yet — bookmark an article to create one.')).toBeVisible();
  });

  test('G50: lists folders, including the auto-created default "Unsorted"', async ({ page }) => {
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });

    // Bookmarking (the real UI flow, already covered end-to-end in
    // article.spec.js) is what lazily creates "Unsorted" — reuse the API
    // directly here since this test is about the Bookmarks *page*, not the
    // button interaction itself.
    await page.request.post(`/api/articles/${article.id}/bookmark`);
    await page.request.post('/api/bookmark-folders', { data: { name: 'Reading List' } });

    await page.goto('/bookmarks');
    await expect(page.locator('.folder-summary-list')).toContainText('Unsorted');
    await expect(page.locator('.folder-summary-list')).toContainText('Reading List');
  });
});

test.describe('Profile page', () => {
  test('H52: shows "No such user" for an unknown username', async ({ page }) => {
    await page.goto('/u/no-such-user-at-all-12345');
    await expect(page.getByText('No such user.')).toBeVisible();
  });

  test('H53+H54: shows display name, @username, hides Follow on your own profile, and lists public articles', async ({
    page,
  }) => {
    const { username, displayName, user } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id, claim: `profile public ${uniqueSlug('r')}`, isPublic: true });

    await page.goto(`/u/${username}`);
    await expect(page.getByRole('heading', { name: displayName })).toBeVisible();
    await expect(page.getByText(`@${username}`)).toBeVisible();
    await expect(page.locator('.follow-button')).toHaveCount(0); // own profile
    await expect(page.locator('.article-card')).toContainText('BOMBSHELL');
    void article;
  });

  test('H54: shows an empty state when a user has no public articles', async ({ page }) => {
    const { username } = await signupViaApi(page);
    await page.goto(`/u/${username}`);
    await expect(page.getByText('No public articles yet.')).toBeVisible();
  });

  test('D32 (moved here): Follow toggles on another user\'s profile page', async ({ page }) => {
    // Follow used to also render on the article page; moved to be
    // profile-only per a real request ("move the follow button to only on
    // the account page").
    await signupViaApi(page);
    const other = await seedRealUser({ displayName: 'Followable Person' });

    await page.goto(`/u/${other.username}`);
    const followButton = page.locator('.follow-button');
    await expect(followButton).toHaveText('Follow');
    await followButton.click();
    await expect(followButton).toHaveText('Following');
    await followButton.click();
    await expect(followButton).toHaveText('Follow');
  });
});
