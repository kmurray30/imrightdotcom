import { useEffect, useRef, useState } from 'react';
import { CrappyEngine } from '../components/crappy/crappyEngine.js';
import { loadSprites } from '../components/crappy/loadSprites.js';

/** Full-viewport playground for Crappy, the poop-snake mascot: click
 * anywhere and he uncurls, slithers over and curls back up. Sprite sheets
 * come from client/public/crappy (see crappy/README.md for the pipeline). */
export function CrappyPage() {
  const canvasRef = useRef(null);
  const [state, setState] = useState('loading');
  const [facing, setFacing] = useState('right');
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let engine = null;
    loadSprites()
      .then((sprites) => {
        if (cancelled || !canvasRef.current) return;
        engine = new CrappyEngine(canvasRef.current, sprites, {
          onState: setState,
          onFacing: (direction) => setFacing(direction < 0 ? 'left' : 'right'),
        });
        engine.start();
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      engine?.stop();
    };
  }, []);

  return (
    <div className="crappy-page" data-crappy-state={error ? 'error' : state} data-crappy-facing={facing}>
      <canvas ref={canvasRef} className="crappy-canvas" aria-label="Crappy playground" />
      <p className={`crappy-hint${error ? ' is-error' : ''}`}>
        {error ? `Crappy isn't here: ${error}` : 'Click anywhere and Crappy will slither over.'}
      </p>
    </div>
  );
}
