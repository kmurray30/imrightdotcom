// Feature area D — Article page (see FEATURE_CHECKLIST.md #25-41), plus the
// cross-cutting guest-gating / direct-link requirements (#55-56).
import { test, expect } from '@playwright/test';
import { seedGuestUser, seedArticle, uniqueSlug } from './helpers/db.js';
import { signupViaApi } from './helpers/auth.js';
import { mergeArticleData, createArticle } from '../../imright/scripts/articles.js';
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

  test('a freshly created article is public by default, with no explicit action needed', async ({ page }) => {
    // Reversed default: articles used to start private and required an
    // explicit "make public" action; now they start public and Private is
    // the explicit opt-out (see VisibilityToggle) — most claims generated
    // here are jokes/bits meant to be shared, not kept private by accident.
    const owner = await seedGuestUser();
    const row = await createArticle({
      ownerUserId: owner.id,
      claimText: 'default visibility check',
      articleData: { version: 1, slug: 'dv', topic: 'x', headline: 'H', intro: 'I', sections: [], conclusion: 'C', citations: [] },
    });
    expect(row.isPublic).toBe(true);

    const response = await page.request.get(`/api/articles/${row.id}`);
    expect((await response.json()).article.isPublic).toBe(true);
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

  test('D27 (guest-owner edge case): a guest owner sees the same toggle, gated behind a sign-up prompt on click', async ({
    page,
    context,
  }) => {
    // Reversed from an earlier design that hid the toggle entirely for a
    // guest owner with inline "Sign up to..." text next to it — now every
    // guest-gated control renders normally and prompts via the shared modal
    // only when actually clicked (see GuestGateContext).
    const owner = await seedGuestUser();
    await setGuestCookie(context, owner.guestCookieId);
    const article = await seedArticle({ ownerUserId: owner.id });

    await page.goto(article.url);
    const toggle = page.locator('.visibility-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Private');
    // A plain .click() here, not .check() — the guest gate intercepts before
    // any state change, so the checkbox never actually becomes checked.
    await toggle.locator('input').click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal')).toContainText('Sign up to make this article public.');
    // Clicking never actually toggled it — still Private once the modal's dismissed.
    await page.locator('.modal button', { hasText: 'Not now' }).click();
    await expect(toggle).toContainText('Private');
  });

  test('D29: liking is allowed on your own article and looks identical to liking someone else\'s', async ({
    page,
  }) => {
    // Reversed requirement: liking your own article used to be blocked
    // (LikeButton hidden entirely on your own article); now it's allowed and
    // rendered the exact same way regardless of ownership.
    const { user } = await signupViaApi(page);
    const ownArticle = await seedArticle({ ownerUserId: user.id });
    await page.goto(ownArticle.url);
    const ownLikeButton = page.locator('.like-button');
    await expect(ownLikeButton).toContainText('♡ 0');
    await ownLikeButton.click();
    await expect(ownLikeButton).toContainText('♥ 1');
    await ownLikeButton.click();
    await expect(ownLikeButton).toContainText('♡ 0');

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

  test('D29: a like persists per-user across a reload (does not reset and allow re-liking)', async ({ page }) => {
    // Real report: liking, leaving, and coming back let the same user like
    // the same article again — the like state was never re-derived from the
    // database on load. GET /api/articles/:id now returns likedByViewer.
    const { user } = await signupViaApi(page);
    const otherOwner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: otherOwner.id });
    void user;

    await page.goto(article.url);
    const likeButton = page.locator('.like-button');
    await likeButton.click();
    await expect(likeButton).toContainText('♥ 1');

    await page.reload();
    await expect(page.locator('.like-button')).toContainText('♥ 1');
  });

  test('D29 (guest): a guest can like without signing up, and it\'s tracked per-guest to prevent duplicates', async ({
    page,
  }) => {
    // Reversed requirement: liking used to be account-gated behind the
    // shared sign-up modal; now it's allowed for anyone, guest included —
    // real engagement counts even without an account. Still idempotent: the
    // guest identity minted on the first like (see ensureOwner in the
    // like route) is what a repeat click/reload keys off of, same guarantee
    // an account gets, just scoped to this browser instead of a login.
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    const likeButton = page.locator('.like-button');
    await expect(likeButton).toBeVisible();
    await expect(likeButton).toContainText('♡ 0');
    await likeButton.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(likeButton).toContainText('♥ 1');

    // A duplicate like attempt from the same guest browser is a no-op, not a
    // second like — reload to re-derive state from the database instead of
    // client-only optimistic state.
    await page.reload();
    await expect(page.locator('.like-button')).toContainText('♥ 1');

    const doubleLike = await page.request.post(`/api/articles/${article.id}/like`);
    expect(doubleLike.ok()).toBe(true);
    const check = await (await page.request.get(`/api/articles/${article.id}`)).json();
    expect(check.article.likeCount).toBe(1);
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

  test('D30 (guest): a guest sees the real Bookmark button, gated behind a sign-up prompt on click', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    const bookmarkButton = page.locator('.bookmark-button');
    await expect(bookmarkButton).toBeVisible();
    await bookmarkButton.click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal')).toContainText('Sign up to bookmark this.');
    await page.locator('.modal button', { hasText: 'Not now' }).click();
    await expect(bookmarkButton).not.toHaveClass(/is-bookmarked/);
  });

  // D32 (Follow) moved off the article page entirely per a real request
  // ("move the follow button to only on the account page") — see
  // history-bookmarks-profile.spec.js's profile-page Follow test.

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

  test('D38+D41: guest sees the real comment composer, gated behind a sign-up prompt on submit, and an empty state with no comments', async ({
    page,
  }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    const composer = page.locator('.comment-composer');
    await expect(composer).toBeVisible();
    await expect(page.getByText('No comments yet.')).toBeVisible();

    await composer.locator('textarea').fill('a guest comment attempt');
    await composer.getByRole('button', { name: 'Post' }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal')).toContainText('Sign up to comment.');
    await page.locator('.modal button', { hasText: 'Not now' }).click();
    // Dismissing the prompt never actually posted it.
    await expect(page.locator('.comment-item')).toHaveCount(0);
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

  test('D40: a comment like persists per-user across a reload', async ({ page }) => {
    // Same fix as the article-level per-user like bug (see D29): GET
    // .../comments now returns likedByViewer per comment.
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    await page.locator('.comment-composer textarea').fill('reload me');
    await page.locator('.comment-composer').getByRole('button', { name: 'Post' }).click();
    const commentLike = page.locator('.comment-item').first().locator('.comment-like');
    await commentLike.click();
    await expect(commentLike).toContainText('♥ 1');

    await page.reload();
    await expect(page.locator('.comment-item').first().locator('.comment-like')).toContainText('♥ 1');
  });

  test('D40 (guest): a guest can like a comment without signing up, tracked per-guest to prevent duplicates', async ({
    page,
  }) => {
    await signupViaApi(page); // the comment's author — a separate identity from the guest liker below
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    const { comment } = await (
      await page.request.post(`/api/articles/${article.id}/comments`, { data: { body: 'like me, guest' } })
    ).json();
    await page.request.post('/api/account/logout');

    await page.goto(article.url);
    const commentLike = page.locator('.comment-item').first().locator('.comment-like');
    await expect(commentLike).toContainText('♡ 0');
    await commentLike.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(commentLike).toContainText('♥ 1');

    // Reload before the follow-up API call so the guest cookie the like just
    // set is guaranteed to be the one page.request sends next (same pattern
    // as the article-like guest test above).
    await page.reload();
    await expect(page.locator('.comment-item').first().locator('.comment-like')).toContainText('♥ 1');

    const doubleLike = await page.request.post(`/api/comments/${comment.id}/like`);
    expect(doubleLike.ok()).toBe(true);
    const check = await (await page.request.get(`/api/articles/${article.id}/comments`)).json();
    expect(check.comments.find((c) => c.id === comment.id).likeCount).toBe(1);
  });

  test('D39 mobile: Enter submits a comment without needing the Post button visible', async ({ page }) => {
    // Real report: "still no way to submit comments on mobile" — the phone
    // keyboard commonly covers the Post button sitting right below the
    // textarea. Enter-to-submit (Shift+Enter for a newline) means the
    // keyboard's own return/send key works regardless of what's visible.
    await page.setViewportSize({ width: 390, height: 844 });
    await signupViaApi(page);
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    const composer = page.locator('.comment-composer textarea');
    await expect(composer).toHaveAttribute('enterkeyhint', 'send');

    await composer.fill('Line one');
    await composer.press('Shift+Enter');
    await composer.type('Line two');
    await expect(composer).toHaveValue('Line one\nLine two');

    await composer.press('Enter');
    await expect(page.locator('.comment-item').first()).toContainText('Line one');
    await expect(page.locator('.comment-item').first()).toContainText('Line two');
    await expect(composer).toHaveValue('');
  });

  test('D42: the article page shows the owner byline and like/comment/bookmark stats', async ({ page }) => {
    // Real report: "doesn't show stats or owner when on an article page" —
    // confirmed: ArticlePage rendered neither at all (the owner, in
    // particular, never saw a like count, since LikeButton hides entirely
    // on your own article).
    const owner = await seedGuestUser({ displayName: 'Stats Owner' });
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);

    await expect(page.locator('.article-byline')).toContainText('Stats Owner');
    const stats = page.locator('.article-stats');
    await expect(stats).toContainText('♥ 0');
    await expect(stats).toContainText('💬 0');
    await expect(stats).toContainText('🔖 0');
  });

  test('D42: the byline links to the owner\'s profile when they have an account', async ({ page }) => {
    const { user, username, displayName } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id });
    // Viewed as someone other than the owner — a self-view renders "by you"
    // instead (see the next test), so log out first to exercise the link.
    await page.request.post('/api/account/logout');
    await page.goto(article.url);

    const bylineLink = page.locator('.article-byline a', { hasText: displayName });
    await expect(bylineLink).toHaveAttribute('href', `/u/${username}`);
  });

  test('D42: your own article shows "by you" instead of your own name/link', async ({ page }) => {
    // Real report: "by Anonymous" on a guest-generated article read as bad
    // design. Same fix applies to a real account viewing their own article —
    // in both cases the owner *is* the viewer, so "by you" reads better than
    // either "Anonymous" or a self-link.
    const { user } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id });
    await page.goto(article.url);

    await expect(page.locator('.article-byline')).toHaveText('by you');
    await expect(page.locator('.article-byline a')).toHaveCount(0);
  });

  test('D42 (guest owner): a guest\'s own article also shows "by you", not "by Anonymous"', async ({
    page,
  }) => {
    await page.request.post('/api/run', { data: { claim: 'guest byline check' } });
    const me = await (await page.request.get('/api/account/me')).json();
    const article = await seedArticle({ ownerUserId: me.user.id });
    await page.goto(article.url);

    await expect(page.locator('.article-byline')).toHaveText('by you');
  });
});

test.describe('Delete article', () => {
  test('the delete trigger is only shown to the owner, styled as a buried/muted link, not a prominent button', async ({
    page,
  }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await page.goto(article.url);
    await expect(page.locator('.delete-article-trigger')).toHaveCount(0);

    const { user } = await signupViaApi(page);
    const ownArticle = await seedArticle({ ownerUserId: user.id });
    await page.goto(ownArticle.url);
    const trigger = page.locator('.delete-article-trigger');
    await expect(trigger).toBeVisible();
    const style = await trigger.evaluate((el) => getComputedStyle(el));
    expect(style.fontSize).toBe('12.8px'); // 0.8rem — smaller than body text
  });

  test('deleting a private article (no double-check needed) removes it from public access and history', async ({
    page,
  }) => {
    const { user } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id, isPublic: false });
    await page.goto(article.url);

    await page.locator('.delete-article-trigger').click();
    const modal = page.locator('.modal');
    await expect(modal).toContainText('Delete this article?');
    // No email-confirm friction for a private article with no interaction.
    await expect(page.getByLabel(/email/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL('/history');

    const check = await page.request.get(`/api/articles/${article.id}`);
    expect(check.status()).toBe(404);
  });

  test('deleting a public article with interaction requires typing the account email first', async ({ page }) => {
    const { user, email } = await signupViaApi(page);
    const article = await seedArticle({ ownerUserId: user.id, isPublic: true });
    const otherLiker = await seedGuestUser();
    void otherLiker;
    // Give it real interaction so the stronger confirmation kicks in.
    await page.request.post(`/api/articles/${article.id}/like`);

    await page.goto(article.url);
    await page.locator('.delete-article-trigger').click();
    const modal = page.locator('.modal');
    await expect(modal).toContainText('This article is public and has activity on it.');

    const deleteButton = page.getByRole('button', { name: 'Delete permanently' });
    await expect(deleteButton).toBeDisabled();

    await page.getByLabel(/email/i).fill('not-my-email@example.test');
    await expect(deleteButton).toBeDisabled();

    await page.getByLabel(/email/i).fill(email);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect(page).toHaveURL('/history');

    const check = await page.request.get(`/api/articles/${article.id}`);
    expect(check.status()).toBe(404);
  });

  test('a guest can delete their own guest-owned article from history', async ({ page }) => {
    await page.request.post('/api/run', { data: { claim: 'guest delete check' } });
    const me = await (await page.request.get('/api/account/me')).json();
    const article = await seedArticle({ ownerUserId: me.user.id });

    await page.goto('/history');
    await expect(page.locator('.history-list li')).toHaveCount(1);
    await page.locator('.delete-article-trigger').click();
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.locator('.history-list li')).toHaveCount(0);

    const check = await page.request.get(`/api/articles/${article.id}`);
    expect(check.status()).toBe(404);
  });
});
