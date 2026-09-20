// Feature area B — Home page / idea generation (see FEATURE_CHECKLIST.md #7-14).
//
// The real pipeline (POST /api/run -> 7-stage Grok pipeline) needs network
// egress this sandbox doesn't have, and is slow even when it does. So the
// happy-path submit test mocks /api/run + /api/stream/:id at the network
// layer with a synthetic SSE stream — this still exercises BeliefForm's
// real event-handling code (the same code a real pipeline run drives), and
// points the mocked `ready` event at a fixture article seeded directly via
// tests/e2e/helpers/db.js, so the test also confirms the navigation lands
// on a real, renderable article page.
import { test, expect } from '@playwright/test';
import { seedGuestUser, seedArticle } from './helpers/db.js';
import { minContrastRatio } from './helpers/contrast.js';

function sseBody(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

test.describe('Home page: idea-input form', () => {
  test('B7: belief form renders with an input and submit button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.belief-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prove me right!' })).toBeVisible();
  });

  test('B7 style: the submit button is a clearly legible, prominent primary action', async ({ page }) => {
    // Real report: "submit buttons area still just white with no visible
    // text" — the button was technically legible (see the earlier
    // button:disabled contrast fix) but visually identical to every
    // secondary button (Share, etc.), with nothing marking it as *the*
    // primary action. It, and the other form-submit buttons like it
    // (Login/Signup/Post), now use a distinct accent-colored style.
    await page.goto('/');
    const submitButton = page.getByRole('button', { name: 'Prove me right!' });
    await expect(submitButton).toHaveClass(/button-primary/);
    expect(await minContrastRatio(submitButton)).toBeGreaterThan(3);
  });

  test('B13: an empty claim cannot be submitted (client-side required check)', async ({ page }) => {
    await page.goto('/');
    let runWasCalled = false;
    await page.route('**/api/run', (route) => {
      runWasCalled = true;
      route.continue();
    });
    await page.getByRole('button', { name: 'Prove me right!' }).click();
    await page.waitForTimeout(200);
    expect(runWasCalled).toBe(false);
  });

  test('B8: submit shows the progress UI immediately, before the run even starts', async ({ page }) => {
    // /api/run is deliberately never fulfilled: BeliefForm sets isSubmitting
    // (and the initial step label/percent) synchronously, before it even
    // awaits the fetch — so this is the one part of the progress UI that's
    // observable with zero race against a mocked backend. (A fully-mocked
    // SSE stream delivers every subsequent event, then closes, then errors,
    // all faster than a first assertion poll can catch — see B9 below for
    // how this suite verifies the event-handling that drives *those*
    // transitions without racing them.)
    // A handler that returns without resolving the route falls through to
    // letting the request continue for real — genuinely hanging it (so the
    // real /api/run + pipeline never fires) needs a promise that never settles.
    await page.route('**/api/run', () => new Promise(() => {}));
    await page.goto('/');
    await page.locator('.belief-input').fill('pigeons are government surveillance drones');
    await page.getByRole('button', { name: 'Prove me right!' }).click();

    await expect(page.locator('.run-progress')).toBeVisible();
    await expect(page.locator('.run-progress-label')).toHaveText('Assembling the case...');
    await expect(page.locator('.run-progress-bar-fill')).toHaveCSS('width', '0px');
  });

  test('B9: progress/stepComplete events are processed on the way to ready (no dead code, no thrown errors)', async ({
    page,
  }) => {
    // Can't snapshot an intermediate label/percent value under a fully
    // mocked, zero-latency backend (see B8's note) — but including these
    // events ahead of 'ready' still proves handleStreamEvent's progress and
    // stepComplete branches run without throwing: if either did, 'ready'
    // would never be reached and the assertions below would fail.
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, claim: 'pigeons are government surveillance drones' });

    await page.route('**/api/run', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'mock-run-full' }) });
    });
    await page.route('**/api/stream/mock-run-full', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          { type: 'progress', step: 1, total: 7, name: 'Assembling the case...' },
          { type: 'stepComplete', step: 1, total: 7, name: 'Assembling the case...' },
          { type: 'progress', step: 2, total: 7, name: 'Searching sources...' },
          { type: 'stepComplete', step: 2, total: 7, name: 'Searching sources...' },
          { type: 'ready', articleId: article.id, url: article.url },
          { type: 'done' },
        ]),
      });
    });

    await page.goto('/');
    await page.locator('.belief-input').fill('pigeons are government surveillance drones');
    await page.getByRole('button', { name: 'Prove me right!' }).click();

    await expect(page).toHaveURL(new RegExp(`/a/${article.id}`));
    await expect(page.locator('h1.article-headline')).toContainText('BOMBSHELL');
  });

  test('B11: a pipeline error event surfaces inline and re-enables the form', async ({ page }) => {
    await page.route('**/api/run', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'mock-run-err' }) });
    });
    await page.route('**/api/stream/mock-run-err', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([{ type: 'error', message: 'Pipeline exploded' }]),
      });
    });

    await page.goto('/');
    await page.locator('.belief-input').fill('the earth is a burrito');
    await page.getByRole('button', { name: 'Prove me right!' }).click();

    await expect(page.locator('.form-error')).toHaveText('Pipeline exploded');
    await expect(page.getByRole('button', { name: 'Prove me right!' })).toBeEnabled();
  });

  test('B12: a dropped SSE connection shows a clear error, not a silent hang', async ({ page }) => {
    await page.route('**/api/run', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'mock-run-drop' }) });
    });
    await page.route('**/api/stream/mock-run-drop', (route) => route.abort());

    await page.goto('/');
    await page.locator('.belief-input').fill('birds are drones');
    await page.getByRole('button', { name: 'Prove me right!' }).click();

    await expect(page.locator('.form-error')).toContainText('Lost connection');
    await expect(page.getByRole('button', { name: 'Prove me right!' })).toBeEnabled();
  });

  test('B14: the Discover feed is rendered below the idea-input form', async ({ page }) => {
    await page.goto('/');
    const formBox = await page.locator('.belief-form-wrapper').boundingBox();
    const feedBox = await page.locator('.discover-feed').boundingBox();
    expect(formBox).toBeTruthy();
    expect(feedBox).toBeTruthy();
    expect(feedBox.y).toBeGreaterThan(formBox.y);
  });

  test('mobile viewport: the belief input gets noticeably more width than the submit button', async ({ page }) => {
    // Real report: on mobile the input/submit split looked like an even
    // 50/50, with the input cramped and the button oversized. Belief input
    // now takes a clear majority share (flex: 3 vs flex: 1 in the mobile
    // media query) instead of an even split.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const inputBox = await page.locator('.belief-input-wrap').boundingBox();
    const buttonBox = await page.locator('.belief-form button[type="submit"]').boundingBox();
    expect(inputBox.width).toBeGreaterThan(buttonBox.width * 1.3);
  });

  test('B15: the home page does not repeat the "imright.com" heading already in the header', async ({ page }) => {
    // Real report: the hero's big <h1>imright.com</h1> was pure duplication
    // of the header logo right above it. The header logo itself (outside
    // .home-page) is untouched and still expected.
    await page.goto('/');
    await expect(page.locator('.home-page').getByText('imright.com')).toHaveCount(0);
    await expect(page.locator('.site-header').getByText('imright.com')).toBeVisible();
  });
});
