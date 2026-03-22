/**
 * Counterarguer: generates scathing debunks for each body section of a tabloid article.
 * One Grok call per section for reliable 1:1 mapping (batch calls often return only 1).
 */

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
 * Generate counterarguments for each body section of the article.
 * Uses one Grok call per section to guarantee exactly N results.
 *
 * @param {object} article - Parsed tabloid article with sections array
 * @param {string} topic - The claim/topic (e.g. "dogs are bad for your mental health")
 * @param {string} [slug] - Filename-safe slug for saving raw input/output
 * @returns {Promise<{ counterarguments: Array<{ blurb: string, analysis: string }> }>}
 */
export async function generateCounterarguments(article, topic, slug = null) {
  const sections = article?.sections ?? [];
  if (sections.length === 0) {
    return { counterarguments: [] };
  }

  const rawInputs = [];
  const rawOutputs = [];
  const counterarguments = [];

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const heading = section.heading ?? '';
    const sectionText = (section.paragraphs ?? [])
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .filter(Boolean)
      .join(' ');

    const userMessage = `Topic/claim the article is pushing: ${topic}

This section only (debunk just this one):

[Section ${index + 1}] ${heading}
${sectionText}

Return JSON: { "blurb": "5-15 word zinger for a thought bubble", "analysis": "2-4 paragraphs: roast the logic, name fallacies, then counterpoints" }`;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];

    rawInputs.push({ sectionIndex: index, heading, messages });

    const rawContent = await callGrok(messages, { response_format: { type: 'json_object' } });
    rawOutputs.push({ sectionIndex: index, heading, rawContent });

    const parsed = parseJsonResponse(rawContent);
    counterarguments.push({
      blurb: parsed.blurb || '',
      analysis: parsed.analysis || '',
    });
  }

  if (slug) {
    const inputDir = path.join(__dirname, 'input');
    const outputDir = path.join(__dirname, 'output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, `${slug}.json`),
      JSON.stringify({ topic, sections: rawInputs }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(outputDir, `${slug}.txt`),
      rawOutputs.map((out) => `--- Section ${out.sectionIndex}: ${out.heading} ---\n${out.rawContent}`).join('\n\n'),
      'utf8'
    );
  }

  return { counterarguments };
}
