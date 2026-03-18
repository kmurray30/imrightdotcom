/**
 * Pure utility functions: HTML escaping, text sanitization, URL validation.
 * No DOM dependencies.
 */

/**
 * Escapes HTML special characters to prevent XSS when injecting user content.
 * @param {unknown} value - Value to escape (coerced to string)
 * @returns {string} Escaped string safe for HTML
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

/**
 * Trims and normalizes string input; returns empty string for non-strings.
 * @param {unknown} value - Value to sanitize
 * @returns {string}
 */
export function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates URL and returns safe href; returns "#" for invalid or non-http(s) URLs.
 * @param {string | null | undefined} url - URL to validate
 * @returns {string} Valid URL or "#"
 */
export function sanitizeUrl(url) {
  if (!url) return "#";
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return "#";
  } catch (error) {
    return "#";
  }
}
