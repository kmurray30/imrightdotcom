/**
 * Robust JSON parser for LLM responses.
 *
 * LLMs often return JSON with extra text, markdown fences, or multiple
 * concatenated objects. This module provides a best-effort extraction
 * strategy that handles these cases gracefully.
 */

/**
 * Attempt to parse JSON from an LLM response string.
 *
 * Strategy (in order):
 * 1. Strip markdown code fences if the response is wrapped in them.
 * 2. Try JSON.parse on the cleaned string.
 * 3. On failure, extract the substring between the first `{` or `[`
 *    and the last matching `}` or `]`, then parse that.
 *
 * @param {string} rawContent - Raw string from LLM
 * @returns {any} - Parsed JSON value
 * @throws {Error} - If no valid JSON can be extracted
 */
export function parseJsonFromLlmResponse(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('Empty or non-string content provided to JSON parser');
  }

  let content = rawContent.trim();

  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(content);
  } catch (directParseError) {
    // Fall through to extraction strategy
  }

  const extracted = extractJsonSubstring(content);
  if (extracted === null) {
    throw new Error(
      `Unable to extract JSON from LLM response. ` +
      `No matching braces/brackets found in: ${content.slice(0, 200)}...`
    );
  }

  try {
    return JSON.parse(extracted);
  } catch (extractedParseError) {
    throw new Error(
      `JSON extraction found candidate but parsing failed: ${extractedParseError.message}. ` +
      `Extracted: ${extracted.slice(0, 200)}...`
    );
  }
}

/**
 * Extract a JSON substring by finding the first `{` or `[` and the last
 * matching `}` or `]`, accounting for balanced nesting and string literals.
 *
 * @param {string} text - Input text possibly containing JSON
 * @returns {string|null} - Extracted JSON substring, or null if not found
 */
function extractJsonSubstring(text) {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let startIndex;
  let openChar;
  let closeChar;

  if (firstBrace === -1 && firstBracket === -1) {
    return null;
  } else if (firstBrace === -1) {
    startIndex = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else if (firstBracket === -1) {
    startIndex = firstBrace;
    openChar = '{';
    closeChar = '}';
  } else if (firstBracket < firstBrace) {
    startIndex = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    startIndex = firstBrace;
    openChar = '{';
    closeChar = '}';
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let endIndex = -1;

  for (let i = startIndex; i < text.length; i++) {
    const character = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (character === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (character === openChar) {
      depth++;
    } else if (character === closeChar) {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    } else if (character === (openChar === '{' ? '[' : '{')) {
      depth++;
    } else if (character === (openChar === '{' ? ']' : '}')) {
      depth--;
    }
  }

  if (endIndex === -1) {
    return null;
  }

  return text.slice(startIndex, endIndex + 1);
}
