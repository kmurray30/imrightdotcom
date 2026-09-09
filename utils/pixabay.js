/**
 * Pixabay API client for fetching and downloading images.
 * Use process.env.PIXABAY_API_KEY (or env.local in project root).
 */

import fs from 'fs';
import path from 'path';
import { callExternalApi, HttpStatusError, timeoutSignal } from './external-api.js';

const PIXABAY_API_BASE = 'https://pixabay.com/api/';
const PIXABAY_TIMEOUT_MS = 15_000;

/**
 * Fetch first matching image URL from Pixabay for a search query.
 *
 * @param {string} query - Search term (e.g. "vaccine vial", "medical documents")
 * @returns {Promise<string|null>} - webformatURL of first hit, or null if no results
 */
export async function fetchImage(query) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'PIXABAY_API_KEY is required. Set it in env or add to env.local in project root.'
    );
  }

  const encodedQuery = encodeURIComponent(query.trim());
  // Never put the API key in a log/error message.
  const url = `${PIXABAY_API_BASE}?key=${apiKey}&q=${encodedQuery}&image_type=photo&safesearch=true&per_page=3`;

  let data;
  try {
    data = await callExternalApi({
      service: 'pixabay',
      operation: 'search',
      pipelineStep: 'image_search',
      fn: async () => {
        const response = await fetch(url, { signal: timeoutSignal(PIXABAY_TIMEOUT_MS) });
        if (!response.ok) {
          const retryAfterHeader = response.headers.get('retry-after');
          throw new HttpStatusError(response.status, `Pixabay API error: ${response.status} ${response.statusText}`, {
            retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
          });
        }
        return response.json();
      },
    });
  } catch (error) {
    if (error?.status === 429) {
      console.error('Pixabay rate limit exceeded, skipping image for:', query);
    } else {
      console.error('Pixabay API error:', error?.status ?? '', error?.message ?? error, 'for query:', query);
    }
    return null;
  }

  const hits = data?.hits ?? [];
  if (hits.length === 0) return null;

  const firstHit = hits[0];
  return firstHit.webformatURL ?? firstHit.largeImageURL ?? null;
}

/**
 * Download an image from a URL to a local file path.
 *
 * @param {string} imageUrl - Full URL of the image (e.g. from Pixabay)
 * @param {string} destPath - Absolute path where the file should be saved
 * @returns {Promise<void>}
 */
export async function downloadImage(imageUrl, destPath) {
  const arrayBuffer = await callExternalApi({
    service: 'pixabay',
    operation: 'download',
    pipelineStep: 'image_search',
    fn: async () => {
      const response = await fetch(imageUrl, { signal: timeoutSignal(PIXABAY_TIMEOUT_MS) });
      if (!response.ok) {
        throw new HttpStatusError(response.status, `Download failed: ${response.status} for ${imageUrl}`);
      }
      return response.arrayBuffer();
    },
  });

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
}
