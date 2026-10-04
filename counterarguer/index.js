/**
 * Counterarguer: generates scathing debunks for each body section of a tabloid article.
 * One Grok call per section for reliable 1:1 mapping (batch calls often return only 1).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callGrokJson } from '../utils/grok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system_prompt.txt'),
  'utf8'
).trim();

/**
 * Generate counterarguments for each body section of the article.
 * Uses one Grok call per section to guarantee exactly N results.
 *
 * @param {object} article - Parsed tabloid article with sections array
 * @param {string} topic - The claim/topic (e.g. "dogs are bad for your mental health")
 * @param {string} [slug] - Filename-safe slug for saving raw input/output
 * @param {object} [options] - Optional config
 * @param {string} [options.model] - Grok model override (defaults to utils/grok.js's DEFAULT_MODEL)
 * @param {string} [options.systemPrompt] - System prompt override (defaults to system_prompt.txt's contents)
 * @param {function} [options.onRawCapture] - Called once (after the per-section loop) with { rawInput: {topic, sections}, rawOutput } — same data the disk-write branch below captures, for callers (e.g. Workshop) that need it without passing a slug
 * @returns {Promise<{ counterarguments: Array<{ blurb: string, analysis: string }> }>}
 */
export async function generateCounterarguments(article, topic, slug = null, options = {}) {
  const sections = article?.sections ?? [];
  if (sections.length === 0) {
    return { counterarguments: [] };
  }

  const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    rawInputs.push({ sectionIndex: index, heading, messages });

    try {
      const { parsed, rawContent } = await callGrokJson(messages, {
        response_format: { type: 'json_object' },
        callerName: `counterarguer/section-${index + 1}`,
        model: options.model,
      });
      rawOutputs.push({ sectionIndex: index, heading, rawContent });

      counterarguments.push({
        blurb: parsed.blurb || '',
        analysis: parsed.analysis || '',
      });
    } catch (sectionError) {
      console.error(`Warning: counterarguer failed for section ${index + 1} ("${heading}"): ${sectionError.message}`);
      rawOutputs.push({ sectionIndex: index, heading, rawContent: `ERROR: ${sectionError.message}` });
      counterarguments.push({ blurb: '', analysis: '' });
    }
  }

  options.onRawCapture?.({
    rawInput: { topic, sections: rawInputs },
    rawOutput: rawOutputs.map((out) => `--- Section ${out.sectionIndex}: ${out.heading} ---\n${out.rawContent}`).join('\n\n'),
  });

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
