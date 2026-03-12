/**
 * Parses Wikipedia {{cite X|...}} templates.
 * Handles case/space variance, pipe-separated params, {{!}} for literal pipe.
 */

const CITE_PATTERN = /^\s*\{\{\s*[Cc]ite\s+([\w-]+)\s*\|/;
const PARAM_PATTERN = /\|([^=]+)=/g;

/**
 * Extract the cite type (web, news, journal, etc.) from template start.
 * @param {string} content - Raw ref content
 * @returns {{ type: string, rest: string } | null}
 */
function matchCiteStart(content) {
  const match = content.match(CITE_PATTERN);
  if (!match) return null;
  const type = match[1].trim().toLowerCase();
  const rest = content.slice(match[0].length);
  return { type, rest };
}

const PIPE_PLACEHOLDER = '\u0001';

/**
 * Parse pipe-separated params. Handles {{!}} as literal pipe in values.
 * @param {string} templateBody - Content between | and }}
 * @returns {Record<string, string>}
 */
function parseParams(templateBody) {
  const params = {};
  const normalized = templateBody.replace(/\{\{\s*!\s*\}\}/g, PIPE_PLACEHOLDER);
  const parts = normalized.split('|');

  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim().toLowerCase().replace(/\s+/g, '_');
    const value = part
      .slice(eqIndex + 1)
      .replace(new RegExp(PIPE_PLACEHOLDER, 'g'), '|')
      .trim();
    if (key && value) params[key] = value;
  }

  return params;
}

/**
 * Find the end of the template (matching }}).
 * @param {string} content - Content starting after {{cite X|
 * @returns {string} - The full template body up to and including the closing }}
 */
function extractTemplateBody(content) {
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    if (content.slice(i, i + 2) === '{{') {
      depth++;
      i += 2;
      continue;
    }
    if (content.slice(i, i + 2) === '}}') {
      depth--;
      i += 2;
      if (depth < 0) {
        return content.slice(0, i - 2);
      }
      continue;
    }
    i++;
  }
  return content;
}

/**
 * Parse a {{cite X|...}} template.
 * @param {string} content - Full ref content (may have leading/trailing whitespace)
 * @returns {{ type: string, url: string | null, blurb: string } | null}
 */
function parseCiteTemplate(content) {
  const citeStart = matchCiteStart(content);
  if (!citeStart) return null;

  const { type, rest } = citeStart;
  const body = extractTemplateBody(rest);
  const params = parseParams(body);

  const url = params.url ?? params.archive_url ?? null;
  if (!url || !url.startsWith('http')) {
    return null;
  }

  const workBlurb = params.work
    ? params.work + (params.date ? ' - ' + params.date : '')
    : '';
  const blurb = (
    params.quote ||
    params.title ||
    workBlurb ||
    params.website ||
    params.journal ||
    ''
  ).slice(0, 500);

  return {
    type,
    url,
    blurb,
  };
}

export { parseCiteTemplate, parseParams, matchCiteStart };
