/**
 * Worker thread for spanWorkerPool.js: runs extractSpans off the main thread.
 * Parsing an article's HTML costs ~10–20 ms of CPU; on the main thread that
 * blocks every chunk's tokenization, COPY encoding and GPU dispatch.
 */
import { parentPort } from 'node:worker_threads';
import { extractSpans } from './spanExtractor.js';

parentPort.on('message', ({ id, title, html, options }) => {
  try {
    const { spans, unembedded } = extractSpans({ name: title, article_body: { html } }, options);
    parentPort.postMessage({ id, spans, unembedded });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.stack || String(error) });
  }
});
