/**
 * Direct-DB test fixtures — the "shortcut" that lets the e2e suite reach an
 * already-generated article page without ever invoking the real 7-stage
 * Grok pipeline (POST /api/run). That pipeline needs network egress to
 * api.x.ai and can take a minute-plus per run, which would make every test
 * that just wants to click "like" or open the bookmark modal both flaky and
 * slow. Instead, this inserts an `articles` row directly via the same
 * `createArticle()` the real server uses, so the row shape is guaranteed to
 * match production exactly.
 *
 * Runs in the Playwright test process itself (not the browser), so it needs
 * its own DATABASE_URL — see playwright.config.js, which sets it for both
 * this process and the webServer child process from one env var.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../imright/scripts/db/index.js';
import { createArticle } from '../../../imright/scripts/articles.js';
import { getArticleImagesRoot } from '../../../utils/image-cache.js';

// A 1x1 transparent PNG — enough for the <img> to actually resolve (200, a
// real image body) so the article-images static mount is exercised for
// real, not just asserted-by-URL-shape.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

export function uniqueSlug(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Inserts a guest `users` row directly (bypassing ensureOwner's HTTP path)
 * — used when a test needs a *second*, non-browser-session identity to own
 * content (e.g. "someone else's" article to like/follow/comment on). */
export async function seedGuestUser({ displayName = 'Fixture Owner' } = {}) {
  const db = getDb();
  const [row] = await db
    .insert(schema.users)
    .values({ isGuest: true, guestCookieId: crypto.randomUUID(), displayName })
    .returning();
  return row;
}

/** Builds an articleData payload matching tabloid_generator/index.js's
 * buildArticleData() shape exactly: headline/intro/sections/conclusion,
 * numbered citations, a `[anchor](N)` inline marker per the plan's citation
 * format, and optionally images + counterarguments per section. */
export function buildFixtureArticleData({ slug, claim, withImages = true, withCounterarguments = true }) {
  const articleData = {
    version: 1,
    slug,
    topic: claim,
    headline: `BOMBSHELL: Insiders Confirm "${claim}" — Here's the Proof`,
    intro: `Sources close to the matter say [the truth is finally out](1), and nobody in the mainstream will tell you.`,
    sections: [
      {
        heading: 'The Evidence Nobody Wants You To See',
        paragraphs: [
          `Documents obtained exclusively show [a pattern going back decades](1).`,
          `Experts we spoke to independently corroborated [every detail](2).`,
        ],
      },
      {
        heading: 'Why This Changes Everything',
        paragraphs: [`Once you see [the full picture](2), there's no going back.`],
      },
    ],
    conclusion: `The only question left is why it took this long for [the truth](1) to surface.`,
    citations: [
      { id: 1, link: 'https://example.com/source-one', archiveLink: null, title: 'Source One' },
      { id: 2, link: 'https://example.com/source-two', archiveLink: 'https://web.archive.org/example', title: 'Source Two' },
    ],
  };

  if (withImages) {
    articleData.images = { hero: 'hero.png', 'section-0': 'section-0.png' };
  }
  if (withCounterarguments) {
    articleData.counterarguments = [
      { blurb: "Bunky isn't so sure about this one.", analysis: 'The cited documents do not actually say that.' },
      { blurb: 'Bunky raises an eyebrow.', analysis: 'This claim conflates correlation with causation.' },
    ];
  }
  return articleData;
}

/** Writes the fixture's placeholder images to disk at the same durable path
 * production uses (getArticleImagesRoot()/<slug>/<filename>), so the
 * article page's <img> tags resolve to a real 200 through the
 * /article-images static mount instead of a broken link. */
export function writeFixtureImages(slug, images) {
  const dir = path.join(getArticleImagesRoot(), slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const filename of Object.values(images ?? {})) {
    fs.writeFileSync(path.join(dir, filename), PLACEHOLDER_PNG);
  }
}

/**
 * The main shortcut: seeds one fully-formed article (owner, content, and —
 * unless overridden — images/counterarguments) directly into Postgres and
 * returns it, ready to navigate straight to `/a/:id`.
 */
export async function seedArticle({
  ownerUserId,
  claim = 'the moon landing was staged in a studio',
  isPublic = false,
  withImages = true,
  withCounterarguments = true,
} = {}) {
  const slug = uniqueSlug('fixture');
  const articleData = buildFixtureArticleData({ slug, claim, withImages, withCounterarguments });
  if (withImages) writeFixtureImages(slug, articleData.images);

  const row = await createArticle({ ownerUserId, claimText: claim, articleData });
  if (isPublic) {
    const db = getDb();
    await db.update(schema.articles).set({ isPublic: true }).where(eq(schema.articles.id, row.id));
    row.isPublic = true;
  }
  return { ...row, url: `/a/${row.id}` };
}

/** Directly sets denormalized engagement counters sky-high so a fixture
 * article deterministically ranks at the top of the Discover feed and
 * search results, regardless of whatever else has accumulated in the dev
 * DB across other test runs. Bypasses the real like/comment/bookmark flows
 * on purpose — those flows are tested for real elsewhere (article.spec.js);
 * this is only about making Discover-ranking assertions deterministic. */
export async function boostEngagement(articleId, { likeCount = 1_000_000 } = {}) {
  const db = getDb();
  await db.update(schema.articles).set({ likeCount }).where(eq(schema.articles.id, articleId));
}
