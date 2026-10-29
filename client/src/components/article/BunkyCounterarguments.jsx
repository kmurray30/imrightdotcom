import { useRef, useState } from 'react';
import { Bunky } from '../bunky/Bunky.jsx';

/** Simplified port of the original floating "Bunky" callout: a per-section
 * button that reveals the counterargument inline instead of a
 * position:absolute-floated bubble — same interaction (click a section to
 * see the skeptical take), simpler visual treatment. */
export function BunkyCallout({ counterargument }) {
  const [open, setOpen] = useState(false);
  const bunky = useRef(null);
  if (!counterargument?.blurb) return null;

  const toggle = () => {
    if (!open) bunky.current?.hop();
    setOpen((o) => !o);
  };

  return (
    <div className="bunky-callout">
      <button type="button" className="bunky-callout-toggle" onClick={toggle}>
        <Bunky ref={bunky} size={26} shadow={false} title="" /> Bunky says...
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
