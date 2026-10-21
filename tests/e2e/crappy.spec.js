// Feature area K — Crappy demo (see FEATURE_CHECKLIST.md #81).
//
// A public full-viewport canvas page where clicking makes Crappy, the
// poop-snake mascot, uncurl, slither to the click point, and curl back up.
// Sprite sheets are manifest-driven (client/public/crappy, built by the
// offline crappy/ pipeline — placeholder art until the fal.ai run lands), so
// these tests assert the state machine and asset serving, never pixels of a
// particular drawing beyond "something dark was painted where he was sent".
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { openMenu } from './helpers/nav.js';

const CLIPS = ['uncurl', 'slither', 'curl'];

async function waitForRest(page) {
  const root = page.locator('.crappy-page');
  await expect(root).toHaveAttribute('data-crappy-state', 'rest', { timeout: 10_000 });
  return root;
}

test.describe('Crappy demo', () => {
  test('K81: the Crappy link is public and opens the playground', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    const link = page.getByRole('link', { name: 'Crappy' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL('/crappy');
    await expect(page.locator('.site-nav-dropdown')).toHaveCount(0);
    await expect(page.locator('.crappy-page')).toBeVisible();
    await expect(page.locator('canvas.crappy-canvas')).toBeVisible();
    await expect(page.locator('.crappy-hint')).toContainText('Click anywhere');
  });

  test('K81: manifest and sheets are served as real assets, not the SPA fallback', async ({ page }) => {
    // The server answers unknown GETs with index.html (200), so a missing
    // manifest would otherwise look like success. Check the content types.
    const manifest = await page.request.get('/crappy/manifest.json');
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()['content-type']).toContain('json');
    const body = await manifest.json();
    for (const clip of CLIPS) {
      expect(body.clips[clip].sheet).toBeTruthy();
      expect(body.clips[clip].frameCount).toBe(body.clips[clip].trajectory.length);
    }
    expect(body.hubs.curled.image).toBeTruthy();
    expect(body.hubs.snake.image).toBeTruthy();

    const sheet = await page.request.get(`/crappy/${body.clips.uncurl.sheet}`);
    expect(sheet.status()).toBe(200);
    expect(sheet.headers()['content-type']).toContain('image/');
    const hub = await page.request.get(`/crappy/${body.hubs.curled.image}`);
    expect(hub.status()).toBe(200);
    expect(hub.headers()['content-type']).toContain('image/');
  });

  test('K81: a click drives rest → uncurl → travel → curl → rest, facing the target', async ({ page }) => {
    await page.goto('/crappy');
    const root = await waitForRest(page);
    await page.mouse.click(900, 500);
    await expect(root).toHaveAttribute('data-crappy-state', 'uncurl', { timeout: 3_000 });
    await expect(root).toHaveAttribute('data-crappy-facing', 'right');
    await expect(root).toHaveAttribute('data-crappy-state', 'travel', { timeout: 5_000 });
    await expect(root).toHaveAttribute('data-crappy-state', 'curl', { timeout: 6_000 });
    await expect(root).toHaveAttribute('data-crappy-state', 'rest', { timeout: 5_000 });
  });

  test('K81: a click during travel retargets instead of stopping, and a leftward target flips facing', async ({
    page,
  }) => {
    await page.goto('/crappy');
    const root = await waitForRest(page);
    await page.mouse.click(1200, 600);
    await expect(root).toHaveAttribute('data-crappy-state', 'travel', { timeout: 5_000 });
    await page.mouse.click(100, 600);
    await expect(root).toHaveAttribute('data-crappy-facing', 'left', { timeout: 1_000 });
    await expect(root).toHaveAttribute('data-crappy-state', 'travel');
    await expect(root).toHaveAttribute('data-crappy-state', 'rest', { timeout: 10_000 });
  });

  test('K81: a click during the curl is queued and played after it', async ({ page }) => {
    await page.goto('/crappy');
    const root = await waitForRest(page);
    await page.mouse.click(700, 450);
    await expect(root).toHaveAttribute('data-crappy-state', 'curl', { timeout: 8_000 });
    await page.mouse.click(300, 450);
    await expect(root).toHaveAttribute('data-crappy-state', 'uncurl', { timeout: 3_000 });
    await expect(root).toHaveAttribute('data-crappy-facing', 'left');
    await expect(root).toHaveAttribute('data-crappy-state', 'rest', { timeout: 10_000 });
  });

  test('K81: Crappy is actually painted where he was sent', async ({ page }) => {
    await page.goto('/crappy');
    const root = await waitForRest(page);
    const tx = 400;
    const ty = 500;
    await page.mouse.click(tx, ty);
    await expect(root).toHaveAttribute('data-crappy-state', 'travel', { timeout: 5_000 });
    await expect(root).toHaveAttribute('data-crappy-state', 'rest', { timeout: 10_000 });
    // The sprite's anchor (his base) sits on the click point, so he is drawn above it.
    const shot = await page.screenshot({ clip: { x: tx - 80, y: ty - 170, width: 160, height: 180 } });
    const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      const lum = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      if (lum < 90) dark++;
    }
    expect(dark).toBeGreaterThan(150);
  });

  test('K81: the header menu still works above the canvas', async ({ page }) => {
    await page.goto('/crappy');
    await expect(page.locator('.crappy-page')).toBeVisible();
    await openMenu(page);
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL('/history');
  });
});
