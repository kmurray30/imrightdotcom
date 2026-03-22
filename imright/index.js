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
} from '../tabloid_generator/index.js';
import { slugify } from './utils.js';
import {
  getTokenUsage,
  resetTokenUsage,
  computeCost,
} from '../utils/grok.js';

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
 * @returns {Promise<{ conspiracy, wikiFetched, wikiFiltered, extracted, html, slug }>}
 */
export async function runPipeline(claim, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const onStepComplete = options.onStepComplete ?? (() => {});
  const totalSteps = 6;
  const slug = slugify(claim);

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
  const html = await renderWithImages(articleResult, slug, PROJECT_ROOT);
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
  saveToDisk(
    path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`),
    html,
    'html'
  );

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

  // Auto-run the debug page generator
  try {
    execSync(`node imright/scripts/generate-debug.js ${slug}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  } catch (generateError) {
    // Non-fatal: pipeline succeeded, debug page may be missing some data
    console.error(`Warning: could not generate debug page: ${generateError.message}`);
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
