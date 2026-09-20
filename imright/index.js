import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import yaml from 'yaml';
import { generateAngles } from '../conspirator/index.js';
import { fetchWiki } from '../wiki_searcher/index.js';
import { filterWiki } from '../wiki_filterer/index.js';
import { extract } from '../ref_extractor/index.js';
import {
  generateArticle,
  renderWithImages,
  regenerateFromRaw,
  buildArticleData,
} from '../tabloid_generator/index.js';
import { generateCounterarguments } from '../counterarguer/index.js';
import { slugify } from './utils.js';
import {
  getTokenUsage,
  resetTokenUsage,
  computeCost,
} from '../utils/grok.js';
import { backfillImageEmbeddings } from '../utils/image-cache.js';
import { upsertBackupLinks } from './scripts/backup-links.js';
import { log } from './scripts/observability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Fire-and-forget save to disk. Does not block or throw to caller.
 */
function saveToDisk(filePath, content, format) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (format === 'json') {
    fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8', () => {});
  } else if (format === 'yaml') {
    fs.writeFile(filePath, yaml.stringify(content, { lineWidth: 0 }), 'utf8', () => {});
  } else {
    fs.writeFile(filePath, content, 'utf8', () => {});
  }
}

/**
 * Runs the full pipeline: claim -> conspirator -> wiki_searcher -> wiki_filterer -> ref_extractor -> tabloid_generator.
 * Data flows in memory; outputs are saved to disk in parallel (fire-and-forget).
 *
 * @param {string} claim - The claim/topic to process
 * @param {object} [options] - Optional config
 * @param {function} [options.onProgress] - Callback (stepIndex, totalSteps, message) for progress updates
 * @param {function} [options.onStepComplete] - Callback (stepIndex, totalSteps, message, delta) after each step; delta = { inputTokens, outputTokens, totalCost, timeMs } for that step
 * @param {function} [options.onPageReady] - Callback (slug, articleData) when the article is
 *   ready to view (after step 6, before step 7) — articleData is buildArticleData()'s shape
 *   (title/body/citations/images), for callers that persist it (e.g. into Postgres) right away
 *   rather than waiting for this whole function to resolve, which would delay "ready" by
 *   however long step 7 (counterarguments) takes.
 * @returns {Promise<{ conspiracy, wikiFetched, wikiFiltered, extracted, html, slug, counterarguments }>}
 */
export async function runPipeline(claim, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const onStepComplete = options.onStepComplete ?? (() => {});
  const onPageReady = options.onPageReady ?? (() => {});
  const totalSteps = 7;
  // A short random suffix, not just slugify(claim): every one of this run's
  // on-disk artifacts (images included) is keyed by this value, and two
  // different submissions of the same claim text must never collide on disk
  // — the exact same identity problem the social layer already fixes for the
  // `articles` table itself (see the plan's "route on the real primary key"
  // section), one layer down in the pipeline's file paths.
  const slug = `${slugify(claim)}-${crypto.randomBytes(4).toString('hex')}`;

  // Remove stale counterarguments so the page doesn't load old results while step 7 runs
  const staleCounterargs = path.join(PROJECT_ROOT, 'tabloid_generator', 'counterarguments', `${slug}.json`);
  fs.rmSync(staleCounterargs, { force: true });

  resetTokenUsage();
  let previousUsage = getTokenUsage();

  const stageRows = [];

  onProgress(1, totalSteps, 'Generating bad-faith angles...');
  const step1Start = performance.now();
  const conspiracy = await generateAngles(claim, { slug });
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    const timeMs = performance.now() - step1Start;
    stageRows.push({
      stage: 1,
      name: 'Generating bad-faith angles...',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cost: deltaCosts.totalCost,
      timeMs,
    });
    onStepComplete(1, totalSteps, 'Generating bad-faith angles...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.yaml`),
    conspiracy,
    'yaml'
  );

  onProgress(2, totalSteps, 'Fetching Wikipedia articles...');
  const step2Start = performance.now();
  const wikiFetched = await fetchWiki(conspiracy);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    const timeMs = performance.now() - step2Start;
    stageRows.push({
      stage: 2,
      name: 'Fetching Wikipedia articles...',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cost: deltaCosts.totalCost,
      timeMs,
    });
    onStepComplete(2, totalSteps, 'Fetching Wikipedia articles...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'wiki_searcher', 'wikis-fetched', `${slug}.yaml`),
    wikiFetched,
    'yaml'
  );

  onProgress(3, totalSteps, 'Filtering articles for relevance...');
  const step3Start = performance.now();
  const wikiFiltered = await filterWiki(conspiracy, wikiFetched);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    const timeMs = performance.now() - step3Start;
    stageRows.push({
      stage: 3,
      name: 'Filtering articles for relevance...',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cost: deltaCosts.totalCost,
      timeMs,
    });
    onStepComplete(3, totalSteps, 'Filtering articles for relevance...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'wiki_filterer', 'wikis-filtered', `${slug}.yaml`),
    wikiFiltered,
    'yaml'
  );

  onProgress(4, totalSteps, 'Extracting citations...');
  const step4Start = performance.now();
  const { extracted, stats: refStats } = await extract(conspiracy, wikiFiltered, { slug });
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    const timeMs = performance.now() - step4Start;
    stageRows.push({
      stage: 4,
      name: 'Extracting citations...',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cost: deltaCosts.totalCost,
      timeMs,
    });
    onStepComplete(4, totalSteps, 'Extracting citations...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs,
      retries: refStats?.linkStats?.retries ?? 0,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'ref_extractor', 'extracted', `${slug}.yaml`),
    extracted,
    'yaml'
  );
  // Fire-and-forget, same spirit as saveToDisk: seeds backup_links for the not-yet-built
  // render-time link healing, but must never slow down or fail article generation.
  upsertBackupLinks(extracted);

  onProgress(5, totalSteps, 'Generating tabloid article...');
  const step5Start = performance.now();
  const articleResult = await generateArticle(claim, extracted, slug);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    const timeMs = performance.now() - step5Start;
    stageRows.push({
      stage: 5,
      name: 'Generating tabloid article...',
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cost: deltaCosts.totalCost,
      timeMs,
    });
    onStepComplete(5, totalSteps, 'Generating tabloid article...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs,
    });
    previousUsage = current;
  })();

  onProgress(6, totalSteps, 'Fetching images...');
  const step6Start = performance.now();
  const { html, imagePaths } = await renderWithImages(articleResult, slug, PROJECT_ROOT);
  (() => {
    const timeMs = performance.now() - step6Start;
    stageRows.push({
      stage: 6,
      name: 'Fetching images...',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      timeMs,
    });
    onStepComplete(6, totalSteps, 'Fetching images...', {
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      timeMs,
    });
  })();
  const htmlPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');

  // Page is ready; open browser now so user can read while step 7 runs.
  // Callers that persist this (the Postgres integration in serve-site.js)
  // need the actual content here, not just the slug — waiting for this
  // whole function to resolve (i.e. for step 7 too) would silently delay
  // "ready" by however long counterarguments take, which is exactly the
  // regression onPageReady exists to avoid.
  const articleDataForPersistence = buildArticleData({
    slug,
    topic: claim,
    article: articleResult.article,
    condensed: articleResult.condensed,
    images: Object.fromEntries(imagePaths),
  });
  onPageReady(slug, articleDataForPersistence);

  // Fire-and-forget, kicked off only now (never before the page is shown):
  // compute CLIP embeddings for any images this run downloaded but hasn't
  // embedded yet. Not awaited here — it runs concurrently with step 7's
  // counterarguments call below (which is itself a multi-second LLM round
  // trip the visitor isn't blocked on either), and is awaited once at the
  // very end purely so it can't outlive the process, never on the path to
  // onPageReady. Failures are caught inside backfillImageEmbeddings itself
  // (logged, not thrown) — this is a "future lookups benefit" side effect,
  // never something that should affect this run's outcome.
  const embeddingBackfillPromise = backfillImageEmbeddings().catch((err) => {
    log('warn', 'image embedding backfill failed', { error: err?.message ?? String(err) });
  });

  // Write run-stats synchronously so the debug generator can read it
  const runStatsPath = path.join(PROJECT_ROOT, 'run-stats', `${slug}.json`);
  fs.mkdirSync(path.dirname(runStatsPath), { recursive: true });
  fs.writeFileSync(
    runStatsPath,
    JSON.stringify(
      {
        slug,
        stages: stageRows,
        refStats: {
          extracted: refStats.extractedCount ?? 0,
          retries: refStats.linkStats?.retries ?? 0,
          deadLinksCount: refStats.linkStats?.deadLinksCount ?? 0,
          deadLinks: refStats.linkStats?.deadLinks ?? [],
        },
      },
      null,
      2
    ),
    'utf8'
  );

  // Step 7: counterarguments. Await so totals are complete before CLI prints.
  // Hoisted so it can be included in this function's return value below —
  // callers that persist article content (the Postgres integration in
  // serve-site.js) need it merged in once it's ready, same as the file-based
  // injection into htmlPath already does for the old static-HTML path.
  let counterarguments = null;
  const sections = articleResult?.article?.sections ?? [];
  if (sections.length > 0) {
    const step7Start = performance.now();
    const step7PreviousUsage = getTokenUsage();
    onProgress(7, totalSteps, 'Generating counterarguments...');

    try {
      ({ counterarguments } = await generateCounterarguments(
        articleResult.article,
        articleResult.topic,
        slug
      ));
      const current = getTokenUsage();
      const delta = {
        inputTokens: current.inputTokens - step7PreviousUsage.inputTokens,
        outputTokens: current.outputTokens - step7PreviousUsage.outputTokens,
      };
      const deltaCosts = computeCost(delta);
      const timeMs = performance.now() - step7Start;
      const stageRow = {
        stage: 7,
        name: 'Generating counterarguments...',
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cost: deltaCosts.totalCost,
        timeMs,
      };
      stageRows.push(stageRow);

      const counterargsDir = path.join(PROJECT_ROOT, 'tabloid_generator', 'counterarguments');
      fs.mkdirSync(counterargsDir, { recursive: true });
      const counterargsPayload = { slug, counterarguments, generated_at: new Date().toISOString() };
      fs.writeFileSync(
        path.join(counterargsDir, `${slug}.json`),
        JSON.stringify(counterargsPayload, null, 2),
        'utf8'
      );

      const htmlPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`);
      if (fs.existsSync(htmlPath)) {
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const placeholder = '<!-- BUNKY_COUNTERARGS_PLACEHOLDER -->';
        const scriptContent = 'window.__BUNKY_COUNTERARGS = ' +
          JSON.stringify(counterargsPayload).replace(/<\/script>/gi, '<\\/script>') +
          ';';
        const injection = '<script>' + scriptContent + '</script>\n  ';
        if (htmlContent.includes(placeholder)) {
          htmlContent = htmlContent.replace(placeholder, injection);
          fs.writeFileSync(htmlPath, htmlContent, 'utf8');
        }
      }

      const runStats = JSON.parse(fs.readFileSync(runStatsPath, 'utf8'));
      runStats.stages = runStats.stages ?? [];
      runStats.stages.push(stageRow);
      fs.writeFileSync(runStatsPath, JSON.stringify(runStats, null, 2), 'utf8');

      onStepComplete(7, totalSteps, 'Generating counterarguments...', {
        ...delta,
        totalCost: deltaCosts.totalCost,
        timeMs,
      });
    } catch (err) {
      console.error('Counterarguments failed:', err.message);
      const timeMs = performance.now() - step7Start;
      stageRows.push({
        stage: 7,
        name: 'Generating counterarguments...',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        timeMs,
        error: err.message,
      });
      onStepComplete(7, totalSteps, 'Generating counterarguments...', {
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        timeMs,
        error: err.message,
      });
    }
  }

  // Let the embedding backfill finish (it's had the entire step-7 duration to
  // run concurrently already) so it can't outlive this function/process —
  // errors were already caught and logged above, so this never throws.
  await embeddingBackfillPromise;

  // Generate debug page once at the end (after table is complete)
  try {
    execSync(`node imright/scripts/generate-debug.js ${slug}`, {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: { ...process.env, IMRIGHT_SILENT_DEBUG: '1' },
    });
  } catch (debugErr) {
    console.error(`Warning: could not generate debug page: ${debugErr.message}`);
  }

  const usage = getTokenUsage();
  const costs = computeCost(usage);

  return {
    conspiracy,
    wikiFetched,
    wikiFiltered,
    extracted,
    html,
    slug,
    stageRows,
    refStats,
    counterarguments,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
      totalCost: costs.totalCost,
    },
  };
}

/**
 * Regenerate only the final HTML and debug HTML from existing pipeline data.
 * Skips conspirator, wiki, extraction, and tabloid LLM—no Grok calls.
 *
 * @param {string} slug - Filename-safe slug (e.g. vaccines-cause-autism)
 * @param {object} [options] - Optional config
 * @returns {Promise<{ slug, html }>}
 */
export async function regenerateHtmlOnly(slug, options = {}) {
  const html = await regenerateFromRaw(slug, PROJECT_ROOT);

  const outputPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  // Inject counterarguments if they exist (works with file://)
  const counterargsPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'counterarguments', `${slug}.json`);
  if (fs.existsSync(counterargsPath)) {
    try {
      const counterargsPayload = JSON.parse(fs.readFileSync(counterargsPath, 'utf8'));
      const placeholder = '<!-- BUNKY_COUNTERARGS_PLACEHOLDER -->';
      const scriptContent = 'window.__BUNKY_COUNTERARGS = ' +
        JSON.stringify(counterargsPayload).replace(/<\/script>/gi, '<\\/script>') +
        ';';
      const injection = '<script>' + scriptContent + '</script>\n  ';
      let htmlWithArgs = fs.readFileSync(outputPath, 'utf8');
      if (htmlWithArgs.includes(placeholder)) {
        htmlWithArgs = htmlWithArgs.replace(placeholder, injection);
        fs.writeFileSync(outputPath, htmlWithArgs, 'utf8');
      }
    } catch (injectErr) {
      // Non-fatal
    }
  }

  try {
    execSync(`node imright/scripts/generate-debug.js ${slug}`, {
      cwd: PROJECT_ROOT,
      stdio: options.silent ? 'pipe' : 'inherit',
    });
  } catch (generateError) {
    if (!options.silent) {
      console.error(`Warning: could not generate debug page: ${generateError.message}`);
    }
    // Non-fatal: tabloid HTML was written successfully
  }

  return { slug, html };
}
