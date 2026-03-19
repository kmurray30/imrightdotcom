import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { generateAngles } from '../conspirator/index.js';
import { fetchWiki } from '../wiki_searcher/index.js';
import { filterWiki } from '../wiki_filterer/index.js';
import { extract } from '../article_extractor/index.js';
import { generate } from '../tabloid_generator/index.js';
import { slugify } from './utils.js';

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
 * Runs the full pipeline: claim -> conspirator -> wiki_searcher -> wiki_filterer -> article_extractor -> tabloid_generator.
 * Data flows in memory; outputs are saved to disk in parallel (fire-and-forget).
 *
 * @param {string} claim - The claim/topic to process
 * @param {object} [options] - Optional config
 * @param {function} [options.onProgress] - Callback (stepIndex, totalSteps, message) for progress updates
 * @returns {Promise<{ conspiracy, wikiFetched, wikiFiltered, extracted, html, slug }>}
 */
export async function runPipeline(claim, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const totalSteps = 5;
  const slug = slugify(claim);

  onProgress(1, totalSteps, 'Generating bad-faith angles...');
  const conspiracy = await generateAngles(claim);
  saveToDisk(
    path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.json`),
    conspiracy,
    'json'
  );

  onProgress(2, totalSteps, 'Fetching Wikipedia articles...');
  const wikiFetched = await fetchWiki(conspiracy);
  saveToDisk(
    path.join(PROJECT_ROOT, 'wiki_searcher', 'wikis-fetched', `${slug}.yaml`),
    wikiFetched,
    'yaml'
  );

  onProgress(3, totalSteps, 'Filtering articles for relevance...');
  const wikiFiltered = await filterWiki(conspiracy, wikiFetched);
  saveToDisk(
    path.join(PROJECT_ROOT, 'wiki_filterer', 'wikis-filtered', `${slug}.yaml`),
    wikiFiltered,
    'yaml'
  );

  onProgress(4, totalSteps, 'Extracting citations...');
  const extracted = await extract(conspiracy, wikiFiltered);
  saveToDisk(
    path.join(PROJECT_ROOT, 'article_extractor', 'extracted', `${slug}.yaml`),
    extracted,
    'yaml'
  );

  onProgress(5, totalSteps, 'Generating tabloid HTML...');
  const html = await generate(claim, extracted);
  saveToDisk(
    path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${slug}.html`),
    html,
    'html'
  );

  return {
    conspiracy,
    wikiFetched,
    wikiFiltered,
    extracted,
    html,
    slug,
  };
}
