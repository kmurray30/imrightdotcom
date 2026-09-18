// Feature area D — Article page (see FEATURE_CHECKLIST.md #25-41), plus the
// cross-cutting guest-gating / direct-link requirements (#55-56).
import { test, expect } from '@playwright/test';
import { seedGuestUser, seedArticle, uniqueSlug } from './helpers/db.js';
import { signupViaApi } from './helpers/auth.js';
import { mergeArticleData } from '../../imright/scripts/articles.js';
import { minContrastRatio } from './helpers/contrast.js';

// Below this, text is the kind of "technically present, not actually
// visible" that a DOM/text-content assertion would happily pass — see
// contrast.js's docstring for the real bug (a near-invisible disabled
// "Post" button) that this threshold is calibrated against: it measured
// ~1.46 broken, ~5.6 fixed.
const MIN_LEGIBLE_CONTRAST = 3;

async function setGuestCookie(context, guestCookieId) {
  await context.addCookies([
    {
      name: 'imright_guest',
      value: guestCookieId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    },
  ]);
}

test.describe('Article page', () => {
  test('D25+D34+D35: loads an article and renders headline, images, sections, and inline citations', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, claim: 'the moon landing was staged' });

    await page.goto(article.url);

    await expect(page.locator('h1.article-headline')).toContainText('BOMBSHELL');
    await expect(page.locator('img.article-hero-image')).toHaveAttribute('src', new RegExp(`/article-images/${article.articleData.slug}/hero.png`));
    // The hero image actually resolves (durable per-article storage, not a 404).
    const heroResponse = await page.request.get(await page.locator('img.article-hero-image').getAttribute('src'));
    expect(heroResponse.status()).toBe(200);

    await expect(page.locator('.article-section')).toHaveCount(2);
    await expect(page.locator('.article-conclusion')).toBeVisible();

    // "[the truth is finally out](1)" renders as a real link to citation #1.
    const citationLink = page.locator('.article-intro .citation-link');
    await expect(citationLink).toHaveText(/the truth is finally out/);
    await expect(citationLink).toHaveAttribute('href', 'https://example.com/source-one');
  });

  test('D26: an unknown article id shows a not-found state', async ({ page }) => {
    await page.goto('/a/00000000-0000-0000-0000-000000000000');
    await expect(page.getByText('Article not found.')).toBeVisible();
  });

  test('I56: a private article is still reachable via its direct link (any visitor, any visibility)', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, isPublic: false });
    await page.goto(article.url);
    await expect(page.locator('h1.article-headline')).toBeVisible();
    await expect(page.getByText('Article not found.')).toHaveCount(0);
  });

  test('D27+D28: owner can toggle visibility and it persists across reload', async ({ page }) => {
    const { user } = await signupViaApi(page);
    // Article must be owned by *this* logged-in account for the toggle to render.
    const article = await seedArticle({ ownerUserId: user.id, isPublic: false });

    await page.goto(article.url);
    const toggle = page.locator('.visibility-toggle');
    await expect(toggle).toContainText('Private');
    await toggle.locator('input').check();
    await expect(toggle).toContainText('Public');

    await page.reload();
    await expect(page.locator('.visibility-toggle')).toContainText('Public');
  });

  test('D27 style: the visibility toggle reads as a real control, not incidental text next to it', async ({ page }) => {
    // Real-user report: the toggle was a bare checkbox+label with no border
    // or background, so unlike its Save/Share siblings in the same actions
    // bar it didn't visually register as a clickable control at all ("no
    // make public/private button... I think"). It was always there and
    // functional (see D27+D28) — this specifically guards the styling that
    // makes it look like one, by requiring the same chrome its siblings have.
    const { user } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id });
    await page.goto(article.url);

    const toggleStyle = await page.locator('.visibility-toggle').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderStyle, background: cs.backgroundColor };
    });
    const shareStyle = await page.locator('.share-button').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderStyle, background: cs.backgroundColor };
    });
    expect(toggleStyle.borderStyle).not.toBe('none');
    expect(toggleStyle.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(toggleStyle).toEqual(shareStyle);
  });

  test('D27 (guest-owner edge case): a guest-owned article shows a sign-up prompt instead of the toggle', async ({
    page,
    context,
  }) => {
    const owner = await seedGuestUser();
    await setGuestCookie(context, owner.guestCookieId);
    const article = await seedArticle({ ownerUserId: owner.id });

    await page.goto(article.url);
    await expect(page.locator('.visibility-toggle')).toHaveCount(0);
    await expect(page.getByText('Sign up to make this article public')).toBeVisible();
  });

  test('D29: Like is hidden on your own article, prompts a guest, and toggles for another logged-in user', async ({
    page,
  }) => {
    const { user } = await signupViaApi(page);
    const ownArticle = await seedArticle({ ownerUserId: user.id });
    await page.goto(ownArticle.url);
    await expect(page.locator('.like-button')).toHaveCount(0);

    const otherOwner = await seedGuestUser();
    const othersArticle = await seedArticle({ ownerUserId: otherOwner.id });
    await page.goto(othersArticle.url);
    const likeButton = page.locator('.like-button');
    await expect(likeButton).toContainText('♡ 0');
    await likeButton.click();
    await expect(likeButton).toContainText('♥ 1');
    await likeButton.click();
    await expect(likeButton).toContainText('♡ 0');
  });

  test('D29 (guest): a guest sees a sign-up prompt instead of a Like button', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    await expect(page.locator('.like-button')).toHaveCount(0);
    await expect(page.getByText('Sign up to like this')).toBeVisible();
  });

  test('D30+D31: bookmark quick-add, then the folder widget on a second click, including a new folder and a duplicate-name error', async ({
    page,
  }) => {
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    const bookmarkButton = page.locator('.bookmark-button');
    await expect(bookmarkButton).not.toHaveClass(/is-bookmarked/);
    await bookmarkButton.click();
    await expect(bookmarkButton).toHaveClass(/is-bookmarked/);

    // Second click on the now-filled icon opens the folder widget instead of unbookmarking.
    await bookmarkButton.click();
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible();
    const unsortedRow = modal.locator('li', { hasText: 'Unsorted' });
    await expect(unsortedRow.locator('input[type=checkbox]')).toBeChecked();

    // Same disabled-button legibility bug as the comment composer's Post
    // button (both come from the same global button:disabled rule) — the
    // "Add" button starts disabled since the folder-name field is empty.
    const addButton = modal.getByRole('button', { name: 'Add' });
    await expect(addButton).toBeDisabled();
    expect(await minContrastRatio(addButton)).toBeGreaterThan(MIN_LEGIBLE_CONTRAST);

    // Unchecking the only folder takes the article back out of "bookmarked."
    await unsortedRow.locator('input[type=checkbox]').uncheck();
    await expect(bookmarkButton).not.toHaveClass(/is-bookmarked/);
    await unsortedRow.locator('input[type=checkbox]').check();

    // Create a new folder inline.
    await modal.getByPlaceholder('New folder name').fill('Reading List');
    await modal.getByRole('button', { name: 'Add' }).click();
    await expect(modal.locator('li', { hasText: 'Reading List' }).locator('input[type=checkbox]')).toBeChecked();

    // Duplicate folder name is rejected with a clear error.
    await modal.getByPlaceholder('New folder name').fill('Reading List');
    await modal.getByRole('button', { name: 'Add' }).click();
    await expect(modal.getByText('You already have a folder with that name.')).toBeVisible();

    await modal.getByRole('button', { name: 'Done' }).click();
    await expect(modal).toHaveCount(0);
  });

  test('D30 (guest): a guest sees a sign-up prompt instead of a Bookmark button', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    await expect(page.locator('.bookmark-button')).toHaveCount(0);
    await expect(page.getByText('Sign up to bookmark this')).toBeVisible();
  });

  test('D32: Follow is hidden on your own article and toggles for another logged-in user', async ({ page }) => {
    const { user } = await signupViaApi(page);
    const ownArticle = await seedArticle({ ownerUserId: user.id });
    await page.goto(ownArticle.url);
    await expect(page.locator('.follow-button')).toHaveCount(0);

    const otherOwner = await seedGuestUser();
    const othersArticle = await seedArticle({ ownerUserId: otherOwner.id });
    await page.goto(othersArticle.url);
    const followButton = page.locator('.follow-button');
    await expect(followButton).toHaveText('Follow');
    await followButton.click();
    await expect(followButton).toHaveText('Following');
    await followButton.click();
    await expect(followButton).toHaveText('Follow');
  });

  test('D33: Share copies the current link and confirms it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    const shareButton = page.locator('.share-button');
    await shareButton.click();
    await expect(shareButton).toHaveText('Link copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(article.id);
  });

  test('D36: a Bunky counterargument callout toggles open and closed', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, withCounterarguments: true });
    await page.goto(article.url);

    const firstSection = page.locator('.article-section').first();
    const toggle = firstSection.locator('.bunky-callout-toggle');
    await expect(toggle).toBeVisible();
    await expect(firstSection.locator('.bunky-bubble')).toHaveCount(0);
    await toggle.click();
    await expect(firstSection.locator('.bunky-blurb')).toContainText("Bunky isn't so sure");
    await toggle.click();
    await expect(firstSection.locator('.bunky-bubble')).toHaveCount(0);
  });

  test('D37: counterarguments that arrive after the page loads are picked up by polling', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, withCounterarguments: false });
    await page.goto(article.url);

    const firstSection = page.locator('.article-section').first();
    await expect(firstSection.locator('.bunky-callout-toggle')).toHaveCount(0);

    await mergeArticleData(article.id, {
      counterarguments: [{ blurb: 'Arrived late but arrived.', analysis: 'Polling caught it.' }],
    });

    await expect(firstSection.locator('.bunky-callout-toggle')).toBeVisible({ timeout: 6000 });
  });

  test('D38+D41: guest sees a sign-up prompt instead of the comment composer, and an empty state with no comments', async ({
    page,
  }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    await expect(page.locator('.comment-composer')).toHaveCount(0);
    await expect(page.getByText('Sign up to comment')).toBeVisible();
    await expect(page.getByText('No comments yet.')).toBeVisible();
  });

  test('D38 style: the disabled Post button stays legible before anything is typed', async ({ page }) => {
    // Real-user report: "no button to send comments" / "send button text is
    // basically invisible". The button was always there and worked once
    // typed into (see D39+D40) — the bug was that its *disabled* state (an
    // empty textarea) rendered at a WCAG contrast ratio of ~1.46 against its
    // own background, i.e. genuinely not perceivable as a button.
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    const postButton = page.locator('.comment-composer').getByRole('button', { name: 'Post' });
    await expect(postButton).toBeDisabled();
    expect(await minContrastRatio(postButton)).toBeGreaterThan(MIN_LEGIBLE_CONTRAST);
  });

  test('D39+D40: a logged-in user can post a comment and like another user\'s comment', async ({ page }) => {
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    const composer = page.locator('.comment-composer textarea');
    await composer.fill('This seems dubious to me.');
    await page.locator('.comment-composer').getByRole('button', { name: 'Post' }).click();

    const firstComment = page.locator('.comment-item').first();
    await expect(firstComment).toContainText('This seems dubious to me.');
    await expect(composer).toHaveValue('');

    const commentLike = firstComment.locator('.comment-like');
    await expect(commentLike).toContainText('♡ 0');
    await commentLike.click();
    await expect(commentLike).toContainText('♥ 1');
  });
});
