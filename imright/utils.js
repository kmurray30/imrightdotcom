/**
 * Convert claim/topic to a safe filename slug: lowercase, spaces to hyphens, strip non-alphanumeric.
 *
 * @param {string} claim - The claim or topic string
 * @returns {string} - Filename-safe slug (e.g. "Foo Bar!" -> "foo-bar")
 */
export function slugify(claim) {
  return (
    claim
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    || 'untitled'
  );
}
