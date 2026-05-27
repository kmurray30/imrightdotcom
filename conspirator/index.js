import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callGrokJson } from '../utils/grok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extract the angles array from a parsed JSON response, regardless of
 * which top-level key Grok decides to use (angles, arguments, etc.).
 *
 * @param {any} parsed - Parsed JSON from Grok
 * @returns {Array} - The extracted array of angle objects
 */
function extractAnglesArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.angles) && parsed.angles.length > 0) {
      return parsed.angles;
    }
    if (Array.isArray(parsed.arguments) && parsed.arguments.length > 0) {
      return parsed.arguments;
    }
    const arrayValues = Object.values(parsed).filter(Array.isArray);
    if (arrayValues.length === 1 && arrayValues[0].length > 0) {
      return arrayValues[0];
    }
  }

  return [];
}

/**
 * Conspirator module: generates bad-faith argument angles for a topic,
 * then consolidates all per-angle search queries into a ranked top-8 list.
 * Uses Grok 4.1 fast non-reasoning via XAI API.
 *
 * @param {string} topic - The claim or topic to generate angles for
 * @param {object} [options] - Optional config
 * @param {string} [options.slug] - Filename-safe slug for saving raw input (e.g. for debug)
 * @returns {Promise<{ topic: string, generated_at: string, search_queries: string[], angles: Array<{ argument: string, search_queries: string[] }> }>}
 */
export async function generateAngles(topic, options = {}) {
  const slug = options.slug ?? null;
  const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, 'system_prompt.txt'),
    'utf8'
  ).trim();

  // Turn 1: generate angles with per-angle search queries.
  const anglesMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Topic: ${topic}\n\nGenerate bad-faith argument angles and search queries for this topic. Return a JSON array of objects, each with "argument" (string) and "search_queries" (array of strings).`,
    },
  ];

  const { parsed, rawContent: rawAnglesContent } = await callGrokJson(anglesMessages, {
    callerName: 'conspirator/angles',
    response_format: { type: 'json_object' },
  });

  const rawAngles = extractAnglesArray(parsed);
  if (rawAngles.length === 0) {
    throw new Error(`Grok returned empty angles. Raw response:\n${rawAnglesContent}`);
  }

  const angles = rawAngles.map((angle) => ({
    argument: angle.argument,
    search_queries: angle.search_queries ?? [],
  }));

  // Turn 2: consolidate all per-angle queries into a top-8 list.
  // Continue the same conversation so Grok has full context of what each query is for.
  const consolidationMessages = [
    ...anglesMessages,
    { role: 'assistant', content: rawAnglesContent },
    {
      role: 'user',
      content:
        'Now look at ALL the search queries you just generated across every angle. ' +
        'Consolidate them into exactly 8 of the highest-value, most distinct Wikipedia search queries. ' +
        'Deduplicate overlapping ones, combine similar ones into a single sharper query, ' +
        'and drop low-value or redundant ones. ' +
        'Return ONLY a JSON object with a "queries" key containing an array of exactly 8 strings.',
    },
  ];

  const { parsed: parsedConsolidated, rawContent: rawConsolidatedContent } = await callGrokJson(
    consolidationMessages,
    { callerName: 'conspirator/consolidation', response_format: { type: 'json_object' } }
  );

  let searchQueries;
  if (Array.isArray(parsedConsolidated)) {
    searchQueries = parsedConsolidated.slice(0, 8).filter((query) => typeof query === 'string' && query.trim());
  } else if (parsedConsolidated && typeof parsedConsolidated === 'object') {
    const arrayValue = parsedConsolidated.queries
      ?? parsedConsolidated.search_queries
      ?? Object.values(parsedConsolidated).find(Array.isArray);
    if (Array.isArray(arrayValue)) {
      searchQueries = arrayValue.slice(0, 8).filter((query) => typeof query === 'string' && query.trim());
    } else {
      searchQueries = [];
    }
  } else {
    searchQueries = [];
  }

  if (searchQueries.length === 0) {
    throw new Error(`Grok returned empty consolidated queries. Raw response:\n${rawConsolidatedContent}`);
  }

  if (slug) {
    const rawOutputDir = path.join(__dirname, 'raw_output');
    fs.mkdirSync(rawOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawOutputDir, `${slug}.txt`),
      `=== ANGLES ===\n${rawAnglesContent}\n\n=== CONSOLIDATED QUERIES ===\n${rawConsolidatedContent}`,
      'utf8'
    );
    const rawInputDir = path.join(__dirname, 'raw_input');
    fs.mkdirSync(rawInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawInputDir, `${slug}.json`),
      JSON.stringify({ anglesMessages, consolidationMessages }, null, 2),
      'utf8'
    );
  }

  return {
    topic,
    generated_at: new Date().toISOString(),
    search_queries: searchQueries,
    angles,
  };
}
