// Admin-only Workshop feature: resume the pipeline from an existing
// article with a different model/system prompt, compare against the
// original. Mirrors article.spec.js's "Admin pipeline debug page" describe
// block's fidelity level — this sandboxed test environment can't reach the
// real xAI API, so a run's actual completion is never asserted on; only
// the admin-gating, DB-backed wiring, and a pre-seeded completed run are.
import { test, expect } from '@playwright/test';
import { seedGuestUser, seedArticle, seedDebugData, seedWorkshopRun, makeAdmin } from './helpers/db.js';
import { signupViaApi } from './helpers/auth.js';
import { openMenu } from './helpers/nav.js';

const VALID_STAGE_CONFIG = {
  5: { provider: 'xai', model: 'grok-4-1-fast-non-reasoning', systemPrompt: 'fixture prompt' },
  7: { provider: 'xai', model: 'grok-4-1-fast-non-reasoning', systemPrompt: 'fixture prompt' },
};

test.describe('Workshop (admin-only)', () => {
  test('a guest gets the generic not-found treatment for the page and the API', async ({ page }) => {
    await page.goto('/workshop');
    await expect(page.locator('.empty-state')).toHaveText('Page not found.');

    const response = await page.request.get('/api/workshop/runs');
    expect(response.status()).toBe(404);
  });

  test('a logged-in non-admin gets the same not-found treatment, and sees no Workshop links', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    await signupViaApi(page);

    await page.goto(article.url);
    await expect(page.locator('a.workshop-debug-link')).toHaveCount(0);
    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Workshop' })).toHaveCount(0);

    await page.goto('/workshop');
    await expect(page.locator('.empty-state')).toHaveText('Page not found.');

    const response = await page.request.get('/api/workshop/runs');
    expect(response.status()).toBe(404);
  });

  test('an admin sees the Workshop nav link and the "Experiment in Workshop" article link', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id });
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);

    await page.goto(article.url);
    const experimentLink = page.locator('a.workshop-debug-link');
    await expect(experimentLink).toBeVisible();
    await expect(experimentLink).toHaveAttribute('href', `/workshop?sourceArticleId=${article.id}`);

    await openMenu(page);
    await expect(page.getByRole('link', { name: 'Workshop', exact: true })).toBeVisible();
  });

  test('starting a from-scratch run (stage 1, no source article) creates a running row', async ({ page }) => {
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);

    const response = await page.request.post('/api/workshop/runs', {
      data: {
        claimText: 'workshop e2e fixture claim',
        startStage: 1,
        stageConfig: {
          1: { provider: 'xai', model: 'grok-4-1-fast-non-reasoning', systemPrompt: 'fixture prompt' },
          ...VALID_STAGE_CONFIG,
        },
      },
    });
    expect(response.status()).toBe(201);
    const { run } = await response.json();
    expect(run.status).toBe('running');
    expect(run.startStage).toBe(1);

    const pollResponse = await page.request.get(`/api/workshop/runs/${run.id}`);
    expect(pollResponse.status()).toBe(200);
    const { run: polled } = await pollResponse.json();
    // Can't reach the real xAI API in this sandboxed environment — the real
    // orchestrator will have already failed it (same tolerance article.spec.js's
    // /api/run tests already have for the live pipeline), but the row must
    // exist and be one of these two states, never stuck unqueried.
    expect(['running', 'error']).toContain(polled.status);
  });

  test('resuming from stage 5 without the source article having debug data is rejected, and the new-run form disables it', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id }); // no debug data seeded
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);

    const response = await page.request.post('/api/workshop/runs', {
      data: { sourceArticleId: article.id, startStage: 5, stageConfig: VALID_STAGE_CONFIG },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe('source_debug_missing');

    await page.goto(`/workshop?sourceArticleId=${article.id}`);
    await expect(page.locator('input[name="startStage"][value="5"]')).toBeDisabled();
    await expect(page.locator('input[name="startStage"][value="7"]')).toBeDisabled();
    await expect(page.locator('input[name="startStage"][value="1"]')).toBeEnabled();
  });

  test('resuming from stage 5 succeeds in creating a run once the source article has debug data', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, claim: 'the government controls the weather' });
    await seedDebugData(article.id, {
      slug: article.articleData.slug,
      extracted: { 'government weather': [{ link: 'https://example.com', title: 'Example', content: 'x', rank: 1 }] },
    });
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);

    await page.goto(`/workshop?sourceArticleId=${article.id}`);
    await expect(page.locator('input[name="startStage"][value="5"]')).toBeEnabled();

    const response = await page.request.post('/api/workshop/runs', {
      data: { sourceArticleId: article.id, startStage: 5, stageConfig: VALID_STAGE_CONFIG },
    });
    expect(response.status()).toBe(201);
    const { run } = await response.json();
    expect(run.sourceArticleId).toBe(article.id);
    expect(run.claimText).toBe(article.claimText);
  });

  test('a completed run renders its debug view and the run page shows a side-by-side compare', async ({ page }) => {
    const owner = await seedGuestUser();
    const article = await seedArticle({ ownerUserId: owner.id, claim: 'the government controls the weather' });
    await seedDebugData(article.id, { slug: article.articleData.slug });
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);

    const run = await seedWorkshopRun({
      createdByUserId: admin.id,
      sourceArticleId: article.id,
      claimText: 'a workshop fixture claim',
      startStage: 5,
      resultData: { slug: 'workshop-fixture-run' },
    });

    const debugResponse = await page.request.get(`/api/workshop/runs/${run.id}/debug`);
    expect(debugResponse.status()).toBe(200);
    expect(debugResponse.headers()['content-type']).toContain('text/html');
    expect(await debugResponse.text()).toContain('Pipeline debug: workshop-fixture-run');

    await page.goto(`/workshop/${run.id}`);
    await expect(page.locator('.workshop-status-done')).toBeVisible();
    await expect(page.locator('.workshop-run-compare iframe')).toHaveCount(2);
  });

  test('a run with no persisted result data 404s on its debug route', async ({ page }) => {
    const { user: admin } = await signupViaApi(page);
    await makeAdmin(admin.id);
    const run = await seedWorkshopRun({ createdByUserId: admin.id, resultData: null });
    // seedWorkshopRun always completes with resultData — build a "still
    // running" row directly to exercise the not-ready case instead.
    const response = await page.request.get(`/api/workshop/runs/${run.id}/debug`);
    // resultData was explicitly null here, so this must 404, not 200 with "null".
    expect(response.status()).toBe(404);
  });
});
