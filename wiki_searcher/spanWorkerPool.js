/**
 * A small pool of worker threads running extractSpans (spanWorker.js), so
 * HTML parsing overlaps with embedding and DB writes instead of blocking the
 * main thread. EXTRACT_WORKERS sets the size (default: cores − 2, between 1
 * and 6); 0 runs extraction inline on the main thread.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { extractSpans } from './spanExtractor.js';

const WORKER_URL = new URL('./spanWorker.js', import.meta.url);
const size = process.env.EXTRACT_WORKERS !== undefined ? Number(process.env.EXTRACT_WORKERS) : Math.max(1, Math.min(6, os.cpus().length - 2));

let workers = null;
let nextId = 1;
const pendingById = new Map(); // id → { resolve, reject, worker }

function startPool() {
  workers = [];
  for (let i = 0; i < size; i++) {
    const worker = new Worker(WORKER_URL);
    worker.busy = 0;
    worker.on('message', (message) => {
      const pending = pendingById.get(message.id);
      if (!pending) return;
      pendingById.delete(message.id);
      worker.busy--;
      if (worker.busy === 0) worker.unref(); // idle again: must not keep the process alive
      if (message.articleError) pending.resolve({ error: message.articleError }); // this article only: the rest of the batch goes on
      else pending.resolve({ spans: message.spans, unembedded: message.unembedded });
    });
    worker.on('error', (error) => {
      for (const [id, pending] of pendingById) {
        if (pending.worker !== worker) continue;
        pendingById.delete(id);
        pending.reject(error);
      }
      // replace the crashed worker so the pool keeps its size
      workers[workers.indexOf(worker)] = null;
      workers = workers.filter(Boolean);
      if (workers.length === 0) workers = null;
    });
    worker.unref(); // idle workers never keep the process alive; a worker with work in flight is ref'd (see extractInWorker)
    workers.push(worker);
  }
}

function extractInWorker(article, options) {
  if (!workers) startPool();
  const worker = workers.reduce((least, w) => (w.busy < least.busy ? w : least), workers[0]);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingById.set(id, { resolve, reject, worker });
    worker.busy++;
    worker.ref(); // the caller is awaiting this: keep the process alive until the reply lands
    worker.postMessage({ id, title: article.title, html: article.html, options });
  });
}

/**
 * extractSpans for many articles, in parallel on the pool. Same order as the input.
 * @param {Array<{title: string, html: string}>} articles
 * @returns {Promise<Array<{spans: Array, unembedded: Array} | {error: string}>>} an article whose extraction threw gets `{ error }`; the others are unaffected
 */
export function extractSpansParallel(articles, options) {
  if (size <= 0 || articles.length === 0) {
    return Promise.resolve(
      articles.map((a) => {
        try {
          return extractSpans({ name: a.title, article_body: { html: a.html } }, options);
        } catch (error) {
          return { error: error?.message || String(error) };
        }
      })
    );
  }
  return Promise.all(articles.map((article) => extractInWorker(article, options)));
}

/** Stops the workers (they are unref'd, so this is only needed to exit promptly). */
export async function shutdownSpanWorkers() {
  if (!workers) return;
  const current = workers;
  workers = null;
  await Promise.all(current.map((w) => w.terminate()));
}
