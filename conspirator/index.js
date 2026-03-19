import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
  const MODEL = 'grok-4-1-fast-non-reasoning';

  const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, 'system_prompt.txt'),
    'utf8'
  ).trim();

  const FILTER_PROMPT = fs.readFileSync(
    path.join(__dirname, 'filter_prompt.txt'),
    'utf8'
  ).trim();

  async function callGrok(topicParam) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
    }

    const response = await fetch(XAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Topic: ${topicParam}\n\nGenerate bad-faith argument angles and search queries for this topic.`,
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`XAI API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    const refusal = message?.refusal;

    if (refusal) {
      throw new Error(`Grok refused the request: ${refusal}`);
    }

    if (!content || (typeof content === 'string' && content.trim() === '')) {
      const debug = JSON.stringify(
        { choices: data.choices, usage: data.usage, model: data.model },
        null,
        2
      );
      throw new Error(`No content in XAI API response. Raw response:\n${debug}`);
    }

    return content;
  }

  async function callFilterGrok(topicParam, angles) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
    }

    const userMessage = `Topic: ${topicParam}\n\nAngles to filter:\n${JSON.stringify(angles, null, 2)}`;

    const response = await fetch(XAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: FILTER_PROMPT },
          { role: 'user', content: userMessage },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`XAI API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    const refusal = message?.refusal;

    if (refusal) {
      throw new Error(`Grok refused the filter request: ${refusal}`);
    }

    if (!content || (typeof content === 'string' && content.trim() === '')) {
      const debug = JSON.stringify(
        { choices: data.choices, usage: data.usage, model: data.model },
        null,
        2
      );
      throw new Error(`No content in XAI API filter response. Raw response:\n${debug}`);
    }

    return content;
  }

  function parseJsonResponse(rawContent) {
    let content = rawContent.trim();
    const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
    }
    return JSON.parse(content);
  }

  const rawContent = await callGrok(topic);

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
      const filterRawContent = await callFilterGrok(topic, anglesToFilter);
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
