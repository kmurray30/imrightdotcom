/**
 * Shared Grok/xAI API client for Node modules.
 * Use process.env.XAI_API_KEY (or env.local in project root).
 * Tracks token usage across calls; use getTokenUsage/resetTokenUsage.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJsonFromLlmResponse } from './parse-json.js';
import { HttpStatusError, classifyTransportError, isRetryableTransportStatus } from './external-api.js';
import { recordLlmCallMetric, recordLlmTokensMetric, recordRetryMetric } from '../imright/scripts/observability.js';
import { getContext, addTokenUsage, recordLlmCallAttempt, markLlmRetry, addTraceEvent } from '../imright/scripts/interaction-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const MAX_JSON_RETRIES = 3;
const MAX_TRANSPORT_RETRIES = 1;
const PROVIDER = 'xai';

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

  const model = options.model ?? DEFAULT_MODEL;
  const pipelineStep = options.callerName ?? 'unknown';
  const maxTransportRetries = options.maxTransportRetries ?? MAX_TRANSPORT_RETRIES;
  const body = {
    model,
    messages,
    stream: false,
    ...(options.response_format && { response_format: options.response_format }),
    ...(options.temperature != null && { temperature: options.temperature }),
  };

  const timeoutMs = options.timeoutMs ?? 60_000;

  async function performRequest() {
    const response = await fetch(XAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const retryAfterHeader = response.headers.get('retry-after');
      throw new HttpStatusError(response.status, `XAI API error ${response.status}: ${errorBody}`, {
        retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
      });
    }

    return response.json();
  }

  // Retries here are transport-level only (timeout/429/5xx/network) — distinct from
  // callGrokJson's retry, which re-calls callGrok because the model's *output* was
  // unparseable, not because the request failed.
  let data;
  for (let attempt = 1; ; attempt++) {
    const isRetry = attempt > 1;
    const start = performance.now();
    try {
      data = await performRequest();
      const latencyMs = performance.now() - start;
      recordLlmCallAttempt({ success: true, isRetry });
      recordLlmCallMetric({ provider: PROVIDER, model, pipelineStep, status: 'success', latencyMs });
      addTraceEvent('llm_call', { provider: PROVIDER, model, pipelineStep, attempt, status: 'success', latencyMs: Math.round(latencyMs) });
      break;
    } catch (error) {
      const latencyMs = performance.now() - start;
      const status = classifyTransportError(error);
      recordLlmCallAttempt({ success: false, isRetry });
      recordLlmCallMetric({ provider: PROVIDER, model, pipelineStep, status, latencyMs });
      addTraceEvent('llm_call', {
        provider: PROVIDER,
        model,
        pipelineStep,
        attempt,
        status,
        latencyMs: Math.round(latencyMs),
        error: String(error?.message ?? error).slice(0, 200),
      });

      const canRetry = isRetryableTransportStatus(status) && attempt <= maxTransportRetries;
      if (!canRetry) throw error;

      recordRetryMetric({ kind: 'llm_transport', pipelineStep, reason: status });
      const retryAfterMs = Number.isFinite(error?.retryAfterSeconds)
        ? Math.min(error.retryAfterSeconds * 1000, 5000)
        : 500 * attempt;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs + Math.random() * 100));
    }
  }

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
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    addTokenUsage(inputTokens, outputTokens);
    const { totalCost } = computeCost({ inputTokens, outputTokens }, model);
    recordLlmTokensMetric({ provider: PROVIDER, model, pipelineStep, inputTokens, outputTokens, cost: totalCost });
  }

  return content;
}

/**
 * Call Grok and parse the response as JSON, with automatic retries.
 *
 * On parse failure, retries the LLM call up to MAX_JSON_RETRIES times total.
 * Each retry logs a serious error to console.error (these are expensive and
 * indicate the model is misbehaving). The parsed JSON object is returned
 * directly rather than the raw string.
 *
 * @param {Array<{ role: string, content: string }>} messages - Chat messages
 * @param {object} [options] - Same options as callGrok, plus:
 * @param {number} [options.maxRetries] - Max total attempts (default: 3)
 * @param {string} [options.callerName] - Name of calling module for error logs
 * @returns {Promise<{ parsed: any, rawContent: string }>} - Parsed JSON and raw response
 */
export async function callGrokJson(messages, options = {}) {
  const maxRetries = options.maxRetries ?? MAX_JSON_RETRIES;
  const callerName = options.callerName ?? 'unknown';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const rawContent = await callGrok(messages, options);

    try {
      const parsed = parseJsonFromLlmResponse(rawContent);
      return { parsed, rawContent };
    } catch (parseError) {
      const isLastAttempt = attempt >= maxRetries;

      console.error(
        `[CRITICAL] ${callerName}: JSON parse failed on attempt ${attempt}/${maxRetries}. ` +
        `Error: ${parseError.message}. ` +
        `Raw response (first 500 chars): ${rawContent.slice(0, 500)}`
      );

      if (isLastAttempt) {
        throw new Error(
          `Failed to parse JSON from Grok response after ${maxRetries} attempts. ` +
          `Last error: ${parseError.message}`
        );
      }

      console.error(
        `[CRITICAL] ${callerName}: Retrying LLM call (attempt ${attempt + 1}/${maxRetries}). ` +
        `This is expensive — the model returned unparseable JSON.`
      );
      markLlmRetry();
      recordRetryMetric({ kind: 'llm_json', pipelineStep: callerName, reason: 'invalid_json' });
    }
  }
}

/**
 * Returns accumulated token usage since last reset, for the current interaction
 * (or a shared fallback accumulator when called outside an interaction context).
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function getTokenUsage() {
  return { ...getContext().tokenUsage };
}

/**
 * Resets the token usage accumulator for the current interaction. Call at the
 * start of each pipeline run.
 */
export function resetTokenUsage() {
  const store = getContext();
  store.tokenUsage.inputTokens = 0;
  store.tokenUsage.outputTokens = 0;
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
