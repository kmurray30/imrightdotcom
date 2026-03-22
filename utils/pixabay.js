/**
 * Pixabay API client for fetching and downloading images.
 * Use process.env.PIXABAY_API_KEY (or env.local in project root).
 */

import fs from 'fs';
import path from 'path';

const PIXABAY_API_BASE = 'https://pixabay.com/api/';

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
  const url = `${PIXABAY_API_BASE}?key=${apiKey}&q=${encodedQuery}&image_type=photo&safesearch=true&per_page=3`;

  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 429) {
      console.error('Pixabay rate limit exceeded, skipping image for:', query);
    } else {
      console.error('Pixabay API error:', response.status, response.statusText, 'for query:', query);
    }
    return null;
  }

  const data = await response.json();
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
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} for ${imageUrl}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
}
