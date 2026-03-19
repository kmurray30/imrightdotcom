/**
 * xAI API integration: fetches biased arguments, headlines, and refutations.
 * og_site is self-contained: always hits xAI directly with XAI_API_KEY from env.js.
 */

import { XAI_MODEL, XAI_CHAT_URL } from "./config.js";
import { BAD_ARGUMENT_PROMPT, SYSTEM_PROMPT, REFUTATION_PROMPT } from "./prompts.js";
import { sanitizeText } from "./utils.js";

// --- API key resolution ---
// Reads from window.ENV (set by env.js) or process.env for Node/bundler contexts
export function resolveXaiApiKey() {
  if (typeof window !== "undefined" && window.ENV?.XAI_API_KEY) {
    return window.ENV.XAI_API_KEY.trim();
  }
  if (typeof process !== "undefined" && process.env?.XAI_API_KEY) {
    return String(process.env.XAI_API_KEY).trim();
  }
  return "";
}

// --- Request helpers ---
// Self-contained: always hit xAI directly with key from env.js
function getApiConfig() {
  const apiKey = resolveXaiApiKey();
  if (!apiKey) {
    throw new Error("XAI_API_KEY is required. Set it in env.js (see env.example.js).");
  }
  return {
    apiUrl: XAI_CHAT_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    }
  };
}

// --- Stage 1: Bad arguments ---
export async function fetchBadArguments(belief) {
  const sanitizedBelief = sanitizeText(belief);
  console.log(`[BiasBot] Stage 1: Generating biased arguments for belief: "${sanitizedBelief}"`);

  const { apiUrl, headers } = getApiConfig();

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: XAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.8,
      messages: [
        { role: "system", content: BAD_ARGUMENT_PROMPT.trim() },
        {
          role: "user",
          content: `Belief: "${sanitizedBelief}". Generate biased supporting arguments only in JSON.`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bad argument generation failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Bad argument generation returned an empty response.");
  }

  const parsedArguments = parseBadArguments(content);
  console.log(`[BiasBot] Stage 1 complete: Generated ${parsedArguments.length} biased arguments.`);
  return parsedArguments;
}

export function parseBadArguments(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    console.warn("Bad argument JSON parse failed, attempting fallback extraction.", error);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Unable to parse bad argument response.");
    payload = JSON.parse(match[0]);
  }

  if (!payload || !Array.isArray(payload.arguments)) {
    throw new Error("Bad argument response missing 'arguments' array.");
  }

  return payload.arguments.slice(0, 5).map((argument) => ({
    heading: sanitizeText(argument.heading ?? "Questionable supporting point"),
    body: sanitizeText(
      argument.body ??
        "Additional biased reasoning unavailable, but assume overwhelming evidence in favor."
    )
  }));
}

// --- Stage 2: Bias Bot articles ---
export async function fetchBiasBotArticles(belief) {
  const sanitizedBelief = sanitizeText(belief);

  let badArguments = [];
  try {
    badArguments = await fetchBadArguments(sanitizedBelief);
  } catch (error) {
    console.error("Failed to generate biased arguments:", error);
  }

  let supportingArgumentsBlock = "";
  if (badArguments.length) {
    const argumentPayload = JSON.stringify({ arguments: badArguments }, null, 2);
    supportingArgumentsBlock = ["Supporting biased arguments to incorporate:", argumentPayload].join(
      "\n"
    );
  }

  console.log(
    `[BiasBot] Stage 2: Requesting biased headlines for "${sanitizedBelief}" with ${badArguments.length} supporting argument(s).`
  );

  const { apiUrl, headers } = getApiConfig();

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: XAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_PROMPT.trim() },
        {
          role: "user",
          content: [
            `Belief: "${sanitizedBelief}".`,
            supportingArgumentsBlock ||
              "Generate sensational supporting coverage even if no additional arguments are provided.",
            "Provide only the JSON object defined in the schema."
          ]
            .filter(Boolean)
            .join("\n\n")
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bias Bot request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Bias Bot returned an empty response.");
  }

  const articles = parseArticles(content);
  console.log(`[BiasBot] Stage 2 complete: Received ${articles.length} biased headline(s).`);
  return articles;
}

export function parseArticles(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    console.warn("Bias Bot JSON parse failed, attempting fallback extraction.", error);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Unable to parse Bias Bot response.");
    payload = JSON.parse(match[0]);
  }

  if (!payload || !Array.isArray(payload.articles)) {
    throw new Error("Bias Bot response missing 'articles' array.");
  }

  return payload.articles.slice(0, 5).map((item) => ({
    title: item.title ?? "Untitled cherry-picked headline",
    source: item.source ?? "Echo Chamber Gazette",
    url: item.url ?? "#",
    snippet: item.summary ?? "Cherry-picked summary unavailable.",
    confirmation: "Supports belief"
  }));
}

// --- Stage 3: Refutation (Reality Check) ---
export async function fetchRefutation(belief, articles) {
  const structuredBiasOutput = {
    belief: sanitizeText(belief),
    articles: articles.map((article) => ({
      title: sanitizeText(article.title),
      source: sanitizeText(article.source),
      summary: sanitizeText(article.snippet),
      url: sanitizeText(article.url)
    }))
  };

  const { apiUrl, headers } = getApiConfig();

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: XAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        { role: "system", content: REFUTATION_PROMPT.trim() },
        {
          role: "user",
          content: [
            `Belief: "${sanitizeText(belief)}"`,
            "Bias Bot Output:",
            JSON.stringify(structuredBiasOutput, null, 2)
          ].join("\n")
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reality Check request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Reality Check returned an empty response.");
  }

  return parseRefutation(content);
}

export function parseRefutation(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    console.warn("Reality Check JSON parse failed, attempting fallback extraction.", error);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Unable to parse Reality Check response.");
    payload = JSON.parse(match[0]);
  }

  const summary = sanitizeText(payload?.summary);

  const expertExamples = Array.isArray(payload?.expert_examples)
    ? payload.expert_examples
        .map((item) => ({
          name: sanitizeText(item?.name),
          title: sanitizeText(item?.title),
          insight: sanitizeText(item?.insight),
          confidence: sanitizeText(item?.confidence)
        }))
        .filter((item) => item.insight)
    : [];

  const refutations = Array.isArray(payload?.refutations)
    ? payload.refutations
        .map((item) => ({
          articleTitle: sanitizeText(item?.article_title),
          issue: sanitizeText(item?.issue),
          correction: sanitizeText(item?.correction)
        }))
        .filter((item) => item.articleTitle || item.correction)
    : [];

  return { summary, expertExamples, refutations };
}
