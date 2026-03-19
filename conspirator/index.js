import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callGrok } from '../utils/grok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Conspirator module: generates bad-faith argument angles for a topic.
 * Each angle includes search queries for corroborating articles.
 * Uses Grok 4.1 fast non-reasoning via XAI API.
 *
 * @param {string} topic - The claim or topic to generate angles for
 * @returns {Promise<{ topic: string, generated_at: string, angles: Array<{ argument: string, search_queries: string[] }> }>}
 */
export async function generateAngles(topic) {
  const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, 'system_prompt.txt'),
    'utf8'
  ).trim();

  const FILTER_PROMPT = fs.readFileSync(
    path.join(__dirname, 'filter_prompt.txt'),
    'utf8'
  ).trim();

  function parseJsonResponse(rawContent) {
    let content = rawContent.trim();
    const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
    }
    return JSON.parse(content);
  }

  const rawContent = await callGrok([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Topic: ${topic}\n\nGenerate bad-faith argument angles and search queries for this topic.`,
    },
  ]);

  let parsed;
  try {
    parsed = parseJsonResponse(rawContent);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from Grok response: ${parseError.message}`);
  }

  const rawAngles = Array.isArray(parsed) ? parsed : (parsed.angles ?? []);
  if (rawAngles.length === 0) {
    throw new Error(`Grok returned empty angles. Raw response:\n${rawContent}`);
  }

  const angles = rawAngles.map((angle) => ({
    argument: angle.argument,
    search_queries: angle.search_queries ?? [],
  }));

  const miscAngle = angles.find(
    (angle) => angle.argument?.toLowerCase() === 'misc search queries'
  );
  if (miscAngle) {
    const topicLower = topic.toLowerCase().trim();
    const alreadyHasTopic = miscAngle.search_queries.some(
      (query) => query.toLowerCase().trim() === topicLower
    );
    if (!alreadyHasTopic) {
      miscAngle.search_queries.unshift(topic);
    }
  }

  const anglesToFilter = angles.filter(
    (angle) => angle.argument?.toLowerCase() !== 'misc search queries'
  );

  let rawFiltered = [];
  if (anglesToFilter.length > 0) {
    try {
      const filterUserMessage = `Topic: ${topic}\n\nAngles to filter:\n${JSON.stringify(anglesToFilter, null, 2)}`;
      const filterRawContent = await callGrok([
        { role: 'system', content: FILTER_PROMPT },
        { role: 'user', content: filterUserMessage },
      ]);
      const filterParsed = parseJsonResponse(filterRawContent);
      rawFiltered = Array.isArray(filterParsed) ? filterParsed : (filterParsed.angles ?? []);
    } catch (filterError) {
      rawFiltered = anglesToFilter.map((angle) => ({
        argument: angle.argument,
        search_queries: angle.search_queries ?? [],
        filtering_thought: null,
        keep: true,
      }));
    }
  }

  const filteredAngles = rawFiltered
    .filter((item) => item.keep === true)
    .map((item) => ({ argument: item.argument, search_queries: item.search_queries ?? [] }));
  if (miscAngle) {
    filteredAngles.push(miscAngle);
  }

  return {
    topic,
    generated_at: new Date().toISOString(),
    angles: filteredAngles,
  };
}
