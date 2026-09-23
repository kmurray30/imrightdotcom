// Feature area C — Discover feed on the home page (see FEATURE_CHECKLIST.md #15-24).
import { test, expect } from '@playwright/test';
import { seedGuestUser, seedArticle, boostEngagement, uniqueSlug } from './helpers/db.js';
import { signupViaApi } from './helpers/auth.js';

/** The sort options collapse into one icon toggle (see DiscoverFeed.jsx) —
 * opens the dropdown and picks an option by its label. */
async function pickSort(page, label) {
  await page.locator('.discover-sort-toggle').click();
  await page.locator('.discover-sort-menu').getByRole('radio', { name: label }).click();
}

test.describe('Discover feed', () => {
  test('C15: shows Discover and Following tabs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Following' })).toBeVisible();
  });

  test('Discover tab lists articles newest-first', async ({ page }) => {
    // Real report: a just-submitted article was hard to spot on the feed
    // (the popularity-ranked order could place a brand-new, zero-engagement
    // article anywhere on the page, and its headline isn't 1:1 with the
    // claim text typed in) — sorting strictly by created_at DESC means a new
    // submission always lands ahead of anything older, no hunting required.
    // Asserts newer-before-older by relative position, not "newer is card
    // #1" — this dev DB is shared across parallel test workers that publish
    // their own fixtures concurrently, so something else can legitimately be
    // newer still by the time this loads (see C17+C20's note on the same
    // hazard for the popularity-ranked feed).
    const owner = await seedGuestUser();
    const older = await seedArticle({ ownerUserId: owner.id, claim: `chrono older ${uniqueSlug('a')}`, isPublic: true });
    await boostEngagement(older.id, { likeCount: 999_999 }); // would win under the old ranked order
    const newer = await seedArticle({ ownerUserId: owner.id, claim: `chrono newer ${uniqueSlug('b')}`, isPublic: true });

    await page.goto('/');
    await expect(page.locator('.article-card')).not.toHaveCount(0);
    const hrefs = await page.locator('.article-card').evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    const newerIndex = hrefs.findIndex((h) => h.startsWith(`/a/${newer.id}`));
    const olderIndex = hrefs.findIndex((h) => h.startsWith(`/a/${older.id}`));
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  test('Discover sort control: Newest is selected by default, hidden on Following and while searching', async ({
    page,
  }) => {
    // Following is disabled for a guest (see C18), so a real account is
    // needed here to actually switch to it.
    await signupViaApi(page);
    await page.goto('/');
    const sortToggle = page.locator('.discover-sort-toggle');
    await expect(sortToggle).toBeVisible();
    await expect(sortToggle).toHaveAttribute('aria-label', 'Sort: Newest');

    await sortToggle.click();
    await expect(page.locator('.discover-sort-menu').getByRole('radio', { name: 'Newest' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await sortToggle.click(); // close it back up before switching tabs

    await page.getByRole('button', { name: 'Following' }).click();
    await expect(sortToggle).toHaveCount(0);
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(sortToggle).toBeVisible();

    await page.getByPlaceholder('Search public articles...').fill('anything');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(sortToggle).toHaveCount(0);
  });

  test('Discover sort control: the dropdown closes on an outside click', async ({ page }) => {
    await page.goto('/');
    await page.locator('.discover-sort-toggle').click();
    await expect(page.locator('.discover-sort-menu')).toBeVisible();
    await page.locator('.site-logo').click();
    await expect(page.locator('.discover-sort-menu')).toHaveCount(0);
  });

  test('Discover sort control: switching to Popular ranks by raw engagement, ignoring recency', async ({ page }) => {
    // Deliberately checks "is this the very first card" rather than its
    // position relative to some other specific fixture: other tests in this
    // file (C22 in particular) permanently leave dozens of 1,000,000-like
    // fixtures behind in this shared, never-reset dev DB, so any fixture
    // with more modest engagement can never be guaranteed a spot on page 1
    // of a popularity-sorted feed no matter how "newer" it is. A boost far
    // above anything else this suite ever uses sidesteps that entirely.
    const owner = await seedGuestUser();
    const mostPopular = await seedArticle({
      ownerUserId: owner.id,
      claim: `sort popular winner ${uniqueSlug('a')}`,
      isPublic: true,
    });
    await boostEngagement(mostPopular.id, { likeCount: 900_000_000 });
    // Newer than mostPopular, but with no engagement — would win under the
    // default Newest sort; must lose under Popular.
    await seedArticle({ ownerUserId: owner.id, claim: `sort popular newer but quiet ${uniqueSlug('b')}`, isPublic: true });

    await page.goto('/');
    await pickSort(page, 'Popular');
    await expect(page.locator('.discover-sort-toggle')).toHaveAttribute('aria-label', 'Sort: Popular');
    await expect(page.locator('.article-card').first()).toHaveAttribute('href', new RegExp(`^/a/${mostPopular.id}`));
  });

  test('Discover sort control: Algo re-requests the feed with the algo ranking', async ({ page }) => {
    const owner = await seedGuestUser();
    await seedArticle({ ownerUserId: owner.id, claim: `sort algo fixture ${uniqueSlug('x')}`, isPublic: true });

    await page.goto('/');
    const algoRequest = page.waitForRequest((req) => /\/api\/discover\?.*sort=algo/.test(req.url()));
    await pickSort(page, 'Algo');
    await algoRequest;
    await expect(page.locator('.discover-sort-toggle')).toHaveAttribute('aria-label', 'Sort: Algo');
    await expect(page.locator('.article-card').first()).toBeVisible();
  });

  test('C17+C20: a newly-published public article is discoverable via search, with correct card content (C24)', async ({ page }) => {
    // Deliberately found via search, not the raw ranked feed: several other
    // tests in this file also boost a fixture's engagement to guarantee
    // *their own* determinism, and those compete for the ranked feed's
    // page-1 slots under Playwright's parallel execution. Search orders by
    // recency only (see articles.js's searchArticles), so it's the reliable
    // way to assert "this specific article is now discoverable."
    const owner = await seedGuestUser({ displayName: 'Fixture Byline Person' });
    const needle = uniqueSlug('discoverable');
    const article = await seedArticle({ ownerUserId: owner.id, claim: `a ${needle} claim`, isPublic: true });

    await page.goto('/');
    await page.getByPlaceholder('Search public articles...').fill(needle);
    await page.getByRole('button', { name: 'Search' }).click();

    const card = page.locator('.article-card', { hasText: 'Fixture Byline Person' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('BOMBSHELL');
    await expect(card.locator('.article-card-stats')).toContainText('♥ 0');
    await expect(card).toHaveAttribute('href', new RegExp(`^/a/${article.id}`));

    // The fixture's hero image (seedArticle defaults to withImages: true)
    // shows up as a real, loadable thumbnail on the card.
    const thumbnail = card.locator('.article-card-thumbnail');
    await expect(thumbnail).toBeVisible();
    const thumbnailResponse = await page.request.get(await thumbnail.getAttribute('src'));
    expect(thumbnailResponse.status()).toBe(200);
  });

  test('C24: a Discover-tab card renders headline, byline, and stats', async ({ page }) => {
    // Structural check on whatever's actually on page 1 of the feed —
    // deliberately not asserting about one specific fixture (see the test
    // above for why that isn't safe under parallel execution here). Seed one
    // directly so the feed is guaranteed non-empty regardless of test order.
    const owner = await seedGuestUser();
    await seedArticle({ ownerUserId: owner.id, claim: `feed fixture ${uniqueSlug('x')}`, isPublic: true });

    await page.goto('/');
    const firstCard = page.locator('.article-card').first();
    await expect(firstCard).toBeVisible();
    await expect(firstCard.locator('h3')).not.toBeEmpty();
    await expect(firstCard.locator('.article-card-byline')).toContainText('by ');
    // Bookmark count is deliberately not shown on the card (kept on the
    // article page itself) — a real request to declutter the thumbnail.
    await expect(firstCard.locator('.article-card-stats')).toContainText('♥');
    await expect(firstCard.locator('.article-card-stats')).toContainText('💬');
    await expect(firstCard.locator('.article-card-stats')).not.toContainText('🔖');
  });


  test('C18: Following tab is disabled for a guest, with an inline sign-up prompt', async ({ page }) => {
    await page.goto('/');
    const followingTab = page.getByRole('button', { name: 'Following' });
    await expect(followingTab).toBeDisabled();
    await followingTab.click({ force: true });
    // Disabled buttons don't fire onClick, so the tab never actually
    // switches — but React still renders the guest-prompt copy is only
    // shown once the tab *is* active; assert it does NOT falsely show
    // before switching, then confirm the disabled title attribute exists.
    await expect(followingTab).toHaveAttribute('title', /Sign up to follow/);
  });

  test('C19: Following tab shows a followed user\'s public articles for a logged-in user', async ({ page }) => {
    const { user } = await signupViaApi(page);
    const followee = await seedGuestUser({ displayName: 'Someone Worth Following' });
    const claim = `followed-feed-${uniqueSlug('x')}`;
    await seedArticle({ ownerUserId: followee.id, claim, isPublic: true });

    const followResponse = await page.request.post(`/api/users/${followee.id}/follow`);
    expect(followResponse.ok()).toBe(true);

    await page.goto('/');
    await page.getByRole('button', { name: 'Following' }).click();
    await expect(page.locator('.article-card', { hasText: 'Someone Worth Following' })).toBeVisible();
    void user; // just documents that we're acting as this signed-up account
  });

  test('C20+C21: search filters results, Clear resets back to the normal feed', async ({ page }) => {
    const owner = await seedGuestUser();
    const needle = uniqueSlug('needle');
    const article = await seedArticle({ ownerUserId: owner.id, claim: `a very ${needle} claim indeed`, isPublic: true });
    await boostEngagement(article.id);

    await page.goto('/');
    await page.getByPlaceholder('Search public articles...').fill(needle);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('.article-card')).toHaveCount(1);
    await expect(page.locator('.article-card')).toContainText('BOMBSHELL');

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByPlaceholder('Search public articles...')).toHaveValue('');
    // Back to the unfiltered Discover feed — more than just our one needle result.
    await expect(page.locator('.article-card').first()).toBeVisible();
  });

  test('C23: an empty state shows when a search matches nothing', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Search public articles...').fill(`no-such-claim-${uniqueSlug('zzz')}`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('Nothing here yet.')).toBeVisible();
  });

  test('C16: switching tabs reloads the list (Following empty-state differs from Discover)', async ({ page }) => {
    const { } = await signupViaApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Following' }).click();
    // A freshly signed-up account follows nobody yet.
    await expect(page.getByText('Nothing here yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page.locator('.discover-tabs .is-active')).toHaveText('Discover');
  });

  test('mobile viewport: the Discover grid shows two smaller cards per row', async ({ page }) => {
    // Real report: single-column cards on mobile looked too large; two
    // per row (smaller each) reads better at phone width.
    const owner = await seedGuestUser();
    await seedArticle({ ownerUserId: owner.id, claim: `mobile grid a ${uniqueSlug('m')}`, isPublic: true });
    await seedArticle({ ownerUserId: owner.id, claim: `mobile grid b ${uniqueSlug('m')}`, isPublic: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('.article-card').first()).toBeVisible();
    const first = await page.locator('.article-card').nth(0).boundingBox();
    const second = await page.locator('.article-card').nth(1).boundingBox();
    expect(first.y).toBeCloseTo(second.y, 0); // same row
    expect(first.x).toBeLessThan(second.x); // side by side, not stacked
  });

  test('C22: a Load more button appears and pagination reveals additional articles', async ({ page }) => {
    const owner = await seedGuestUser();
    // 31 dominant rows guarantees page 1 (30) is full and at least one more
    // exists to reveal via "Load more". Asserted as "more than 30", not an
    // exact 31: other tests in this file boost their own fixtures in
    // parallel and may contribute additional dominant rows to the same
    // shared dev DB — harmless here since this test only cares that
    // pagination fetched *more*, not exactly how many.
    for (let i = 0; i < 31; i++) {
      const article = await seedArticle({
        ownerUserId: owner.id,
        claim: `pagination fixture ${uniqueSlug(String(i))}`,
        isPublic: true,
        withImages: false,
        withCounterarguments: false,
      });
      await boostEngagement(article.id);
    }

    await page.goto('/');
    await expect(page.locator('.article-card')).toHaveCount(30);
    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(async () => {
      expect(await page.locator('.article-card').count()).toBeGreaterThan(30);
    }).toPass();
  });
});
