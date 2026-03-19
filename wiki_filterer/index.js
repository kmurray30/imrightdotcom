import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callGrok } from '../utils/grok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system_prompt.txt'),
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

/**
 * Filters Wikipedia articles for relevance to arguments from conspiracy data.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with argument)
 * @param {object} wikiFetchedData - Output from wiki_searcher (query, pages)
 * @returns {Promise<{ query: string, arguments: string[], fetched_at: string|null, filtered_at: string, page_count: number, pages: object[] }>}
 */
export async function filterWiki(conspiracyData, wikiFetchedData) {
  const argumentsList = (conspiracyData.angles ?? []).map((angle) => angle.argument).filter(Boolean);

  if (argumentsList.length === 0) {
    throw new Error('No arguments found in conspiracy data.');
  }

  const pages = wikiFetchedData?.pages ?? [];

  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    throw new Error('No pages found in wiki data or invalid structure.');
  }

  const pagesByPageid = new Map(pages.map((page) => [page.pageid, page]));
  const pagesByTitle = new Map(pages.map((page) => [page.title, page]));

  const pageObjects = pages.map((page) => ({
    title: page.title ?? null,
    pageid: page.pageid ?? null,
    extract: page.extract ?? null,
  }));

  const seenPageids = new Set();
  const filteredPages = [];

  for (const argument of argumentsList) {
    const userMessage = `Argument: ${argument}

Wikipedia articles to filter:

${JSON.stringify(pageObjects, null, 2)}

Return only the articles relevant to this argument as a JSON array of {title, id} objects.`;
    const rawContent = await callGrok([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]);

    let parsedResponse;
    try {
      parsedResponse = parseJsonResponse(rawContent);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON from Grok response: ${parseError.message}`);
    }

    const rawList = Array.isArray(parsedResponse) ? parsedResponse : (parsedResponse.articles ?? []);

    for (const item of rawList) {
      const pageid = item.id ?? item.pageid ?? item.pageId;
      const title = item.title ?? item.Title;
      let page = pageid ? pagesByPageid.get(pageid) : null;
      if (!page && title) {
        page = pagesByTitle.get(title);
      }
      if (page && !seenPageids.has(page.pageid)) {
        seenPageids.add(page.pageid);
        filteredPages.push(page);
      }
    }
  }

  return {
    query: wikiFetchedData.query ?? conspiracyData.topic ?? '',
    arguments: argumentsList,
    fetched_at: wikiFetchedData.fetched_at ?? null,
    filtered_at: new Date().toISOString(),
    page_count: filteredPages.length,
    pages: filteredPages,
  };
}
