/**
 * Pixel-level legibility check — catches "the text is technically there but
 * you can't actually see it" bugs that a DOM/text-content assertion can't:
 * Playwright's `toHaveText()` passes regardless of whether the text is
 * rendered black-on-white or pale-gray-on-near-white. This renders the
 * element for real (a real screenshot, post-CSS, post-opacity-compositing,
 * post-antialiasing) and computes the actual WCAG relative-luminance
 * contrast ratio between its darkest and lightest pixels — a cheap, good
 * -enough proxy for "text vs. background" in a small, mostly two-tone
 * control like a button, without needing OCR or font metrics.
 *
 * Written after a real bug this exact technique would have caught: a global
 * `button:disabled { opacity: 0.6 }` rule compounded with this app's
 * already-subtle white-button-on-cream-page palette to render disabled
 * button labels (e.g. the comment composer's "Post" button before any text
 * is typed) as barely-visible pale gray — invisible enough that a real user
 * reported "there's no button to send comments," even though the button was
 * present, enabled correctly, and fully clickable the whole time.
 */

import sharp from 'sharp';

function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Returns the WCAG contrast ratio (1 = no contrast at all, 21 = max)
 * between the darkest and lightest pixel in a screenshot of `locator`. */
export async function minContrastRatio(locator) {
  const buffer = await locator.screenshot();
  const { data, info } = await sharp(buffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  let minLum = 1;
  let maxLum = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = relativeLuminance(data[i], data[i + 1], data[i + 2]);
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }
  return (maxLum + 0.05) / (minLum + 0.05);
}
