import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { generateAngles } from '../conspirator/index.js';
import { fetchWiki } from '../wiki_searcher/index.js';
import { filterWiki } from '../wiki_filterer/index.js';
import { extract } from '../ref_extractor/index.js';
import { generate } from '../tabloid_generator/index.js';
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
  const totalSteps = 5;
  const slug = slugify(claim);

  resetTokenUsage();
  let previousUsage = getTokenUsage();

  onProgress(1, totalSteps, 'Generating bad-faith angles...');
  const step1Start = performance.now();
  const conspiracy = await generateAngles(claim);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    onStepComplete(1, totalSteps, 'Generating bad-faith angles...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs: performance.now() - step1Start,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.json`),
    conspiracy,
    'json'
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
    onStepComplete(2, totalSteps, 'Fetching Wikipedia articles...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs: performance.now() - step2Start,
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
    onStepComplete(3, totalSteps, 'Filtering articles for relevance...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs: performance.now() - step3Start,
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
  const extracted = await extract(conspiracy, wikiFiltered);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    onStepComplete(4, totalSteps, 'Extracting citations...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs: performance.now() - step4Start,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'ref_extractor', 'extracted', `${slug}.yaml`),
    extracted,
    'yaml'
  );

  onProgress(5, totalSteps, 'Generating tabloid HTML...');
  const step5Start = performance.now();
  const html = await generate(claim, extracted);
  (() => {
    const current = getTokenUsage();
    const delta = {
      inputTokens: current.inputTokens - previousUsage.inputTokens,
      outputTokens: current.outputTokens - previousUsage.outputTokens,
    };
    const deltaCosts = computeCost(delta);
    onStepComplete(5, totalSteps, 'Generating tabloid HTML...', {
      ...delta,
      totalCost: deltaCosts.totalCost,
      timeMs: performance.now() - step5Start,
    });
    previousUsage = current;
  })();
  saveToDisk(
    path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`),
    html,
    'html'
  );

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
