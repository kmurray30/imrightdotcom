import { useState } from 'react';

/** Simplified port of the original floating "Bunky" callout: a per-section
 * button that reveals the counterargument inline instead of a
 * position:absolute-floated bubble — same interaction (click a section to
 * see the skeptical take), simpler visual treatment. */
export function BunkyCallout({ counterargument }) {
  const [open, setOpen] = useState(false);
  if (!counterargument?.blurb) return null;

  return (
    <div className="bunky-callout">
      <button type="button" className="bunky-callout-toggle" onClick={() => setOpen((o) => !o)}>
        🐶 Bunky says...
      </button>
      {open && (
        <div className="bunky-bubble">
          <p className="bunky-blurb">{counterargument.blurb}</p>
          {counterargument.analysis && <p className="bunky-analysis">{counterargument.analysis}</p>}
        </div>
      )}
    </div>
  );
}
