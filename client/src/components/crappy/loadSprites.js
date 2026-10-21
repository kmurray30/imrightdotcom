/**
 * Fetch the sprite manifest and decode every sheet and hub image up front,
 * so the first frame drawn never waits on the network.
 *
 * The Express server answers unknown GETs with the SPA's index.html (200),
 * so a missing manifest arrives as HTML: the content-type check turns that
 * into a readable error instead of a JSON parse failure.
 */
export const SPRITES_BASE = '/crappy';

export async function loadSprites(baseUrl = SPRITES_BASE) {
  const response = await fetch(`${baseUrl}/manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`manifest request failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error('sprite manifest is missing (run `npm run crappy -- placeholder` or `extract`)');
  }
  const manifest = await response.json();
  if (!manifest?.clips || !manifest?.hubs) throw new Error('sprite manifest has no clips/hubs');

  const version = encodeURIComponent(manifest.generatedAt || '');
  const loadImage = async (file) => {
    const image = new Image();
    image.decoding = 'async';
    image.src = `${baseUrl}/${file}?v=${version}`;
    await image.decode();
    return image;
  };
  const loadMap = async (entries, pick) => {
    const pairs = await Promise.all(
      Object.entries(entries).map(async ([name, entry]) => [name, await loadImage(pick(entry))])
    );
    return Object.fromEntries(pairs);
  };
  const [sheets, hubs] = await Promise.all([
    loadMap(manifest.clips, (clip) => clip.sheet),
    loadMap(manifest.hubs, (hub) => hub.image),
  ]);
  return { manifest, sheets, hubs };
}
