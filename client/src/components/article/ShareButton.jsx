import { useState } from 'react';

/** Any article is shareable via its direct link regardless of visibility
 * (requirement 4) — this never checks isPublic. */
export function ShareButton() {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to fall
      // back to here beyond the user copying the URL bar themselves.
    }
  }

  return (
    <button type="button" className="share-button" onClick={handleClick}>
      {copied ? 'Link copied!' : 'Share'}
    </button>
  );
}
