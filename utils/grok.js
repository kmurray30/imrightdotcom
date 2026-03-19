/**
 * Shared Grok/xAI API client for Node modules.
 * Use process.env.XAI_API_KEY (or env.local in project root).
 * Tracks token usage across calls; use getTokenUsage/resetTokenUsage.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';

/** Module-level accumulator for token usage across callGrok invocations. */
const tokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Call Grok chat completions API.
 *
 * @param {Array<{ role: string, content: string }>} messages - Chat messages (system, user, etc.)
 * @param {object} [options] - Optional overrides
 * @param {string} [options.model] - Model name (default: grok-4-1-fast-non-reasoning)
 * @param {object} [options.response_format] - e.g. { type: 'json_object' }
 * @param {number} [options.temperature] - Sampling temperature
 * @param {string} [options.apiKey] - Override API key (default: process.env.XAI_API_KEY)
 * @returns {Promise<string>} - The message content from the first choice
 */
export async function callGrok(messages, options = {}) {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'XAI_API_KEY is required. Set it in env or add to env.local in project root.'
    );
  }

  const body = {
    model: options.model ?? DEFAULT_MODEL,
    messages,
    stream: false,
    ...(options.response_format && { response_format: options.response_format }),
    ...(options.temperature != null && { temperature: options.temperature }),
  };

  const response = await fetch(XAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify(body),
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

  const usage = data.usage;
  if (usage) {
    tokenUsage.inputTokens += usage.prompt_tokens ?? 0;
    tokenUsage.outputTokens += usage.completion_tokens ?? 0;
  }

  return content;
}

/**
 * Returns accumulated token usage since last reset.
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function getTokenUsage() {
  return { ...tokenUsage };
}

/**
 * Resets the token usage accumulator. Call at the start of each pipeline run.
 */
export function resetTokenUsage() {
  tokenUsage.inputTokens = 0;
  tokenUsage.outputTokens = 0;
}

/**
 * Computes cost in USD from token usage using pricing JSON.
 *
 * @param {{ inputTokens: number, outputTokens: number }} usage - Token counts
 * @param {string} [model] - Model ID for pricing lookup (default: grok-4-1-fast-non-reasoning)
 * @param {string} [pricingPath] - Path to grok-pricing.json (default: next to this file)
 * @returns {{ inputCost: number, outputCost: number, totalCost: number }}
 */
export function computeCost(usage, model = DEFAULT_MODEL, pricingPath) {
  const resolvedPath = pricingPath ?? path.join(__dirname, 'grok-pricing.json');
  let pricing;
  try {
    pricing = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (readError) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const rates = pricing[model] ?? pricing[DEFAULT_MODEL];
  if (!rates) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const inputPerMillion = rates.input_per_million ?? 0;
  const outputPerMillion = rates.output_per_million ?? 0;
  const inputCost = (usage.inputTokens / 1e6) * inputPerMillion;
  const outputCost = (usage.outputTokens / 1e6) * outputPerMillion;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}
