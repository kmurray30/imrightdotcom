import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import bodyUrl from './bunky-body.webp';
import { createBunkyController } from './bunkyController.js';
import { EYES, LINE, PUPIL, faceAttrs } from './bunkyFace.js';
import { resolveExpression } from './expressions.js';

/* Bunky, animatable. The body is the original drawing with its face painted
 * out (assets/bunky-anim/make-body.py, saved here as WebP); the face is SVG
 * drawn on top, in the drawing's 294x270 coordinates, so it can move.
 * Expressions live in expressions.js.
 *
 *   <Bunky expression="content" idle />   // changing `expression` animates
 *
 * Triggers, through a ref:
 *   const bunky = useRef(null);
 *   <Bunky ref={bunky} size={48} />
 *   bunky.current.hop();
 *   bunky.current.react('laughing');            // go there, hold, settle back
 *   bunky.current.react('angry', { hold: Infinity }); // stay...
 *   bunky.current.relax();                      // ...until this
 *   bunky.current.setExpression('sad');         // go there and stay
 *   bunky.current.surprise();                   // = react('surprised')
 *   bunky.current.blink();
 * Each returns a promise that resolves when that animation ends (or is
 * interrupted by another one of the same kind). */

const VIEW_W = 294;
const VIEW_H = 280; // drawing plus room for the ground shadow
const METHODS = ['setExpression', 'play', 'react', 'surprise', 'relax', 'preview', 'blink', 'hop'];

/** The Bunky's controller, created on first use (most Bunkys never animate). */
function ensureController(controllerRef, svgRef, baseRef, initial) {
  controllerRef.current ??= createBunkyController(svgRef.current, {
    initial,
    getBase: () => baseRef.current,
  });
  return controllerRef.current;
}

export function Bunky({ ref, expression = 'skeptical', idle = false, size = 64, shadow = true, className = '', title = 'Bunky' }) {
  const id = `bunky-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef(null);
  const controllerRef = useRef(null);
  const baseRef = useRef(expression);
  // The face is rendered once from this; later changes animate instead.
  const [initial] = useState(expression);

  useEffect(() => {
    baseRef.current = expression;
    if (expression !== initial || controllerRef.current) ensureController(controllerRef, svgRef, baseRef, initial).setExpression(expression);
  }, [expression, initial]);

  useEffect(() => {
    if (idle) ensureController(controllerRef, svgRef, baseRef, initial).startIdle();
    else controllerRef.current?.stopIdle();
  }, [idle, initial]);

  useEffect(() => () => controllerRef.current?.destroy(), []);

  useImperativeHandle(
    ref,
    () =>
      Object.fromEntries(
        METHODS.map((name) => [name, (...args) => ensureController(controllerRef, svgRef, baseRef, initial)[name](...args)]),
      ),
    [initial],
  );

  const face = faceAttrs(resolveExpression(initial).pose);
  const eyeClip = (i) => `url(#${id}-eye-${i})`;
  return (
    <svg
      ref={svgRef}
      className={`bunky ${className}`.trim()}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={size}
      height={(size * VIEW_H) / VIEW_W}
      // title="" marks him decorative, e.g. next to text that already says "Bunky".
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        {/* A little wobble so the vector lines sit with the crayon drawing. */}
        <filter id={`${id}-crayon`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {EYES.map(([cx, cy], i) => (
          <clipPath key={i} id={`${id}-eye-${i}`}>
            <circle data-part="eye-clip" cx={cx} cy={cy} r={face.eyeClip.r} />
          </clipPath>
        ))}
        {EYES.map((_, i) => (
          <clipPath key={i} id={`${id}-lid-${i}`}>
            <path data-part="lid-fill" d={face.lidFills[i].d} />
          </clipPath>
        ))}
        <clipPath id={`${id}-mouth-clip`}>
          <use href={`#${id}-mouth`} />
        </clipPath>
      </defs>
      {shadow && <ellipse data-part="shadow" className="bunky-shadow" cx="147" cy="268" rx="112" ry="9" fill={LINE} opacity="0.28" />}
      <g data-part="hop" className="bunky-squash">
        <g data-part="jolt" className="bunky-squash">
          <g data-part="breath" className="bunky-squash">
            <g data-part="pose" transform={face.pose.transform}>
              <image href={bodyUrl} width="294" height="270" />
              <g data-part="face" className="bunky-part" filter={`url(#${id}-crayon)`}>
                {[58, 226].map((cx) => (
                  <ellipse key={cx} data-part="blush" cx={cx} cy="196" rx="15" ry="8" fill="#f08a78" opacity={face.blush.opacity} />
                ))}
                {EYES.map(([cx, cy]) => (
                  <circle key={cx} data-part="eye" cx={cx} cy={cy} r={face.eye.r} fill="#fff" />
                ))}
                <g data-part="pupils" className="bunky-part">
                  {face.pupils.map((p, i) => (
                    <g key={i} clipPath={eyeClip(i)}>
                      <circle data-part="pupil" {...p} fill={PUPIL} />
                      <circle data-part="glint" {...face.glints[i]} fill="#fff" />
                    </g>
                  ))}
                </g>
                {EYES.map(([cx, cy]) => (
                  <circle key={cx} data-part="eye" cx={cx} cy={cy} r={face.eye.r} fill="none" stroke={LINE} strokeWidth="2.8" />
                ))}
                {/* Eyelids are the body drawing itself, clipped to the lid
                    shape, so they match his texture exactly. */}
                {EYES.map((_, i) => (
                  <g key={i} clipPath={eyeClip(i)}>
                    <image href={bodyUrl} width="294" height="270" clipPath={`url(#${id}-lid-${i})`} />
                    <path data-part="lid-line" d={face.lidLines[i].d} fill="none" stroke={LINE} strokeWidth="2.8" strokeLinecap="round" />
                  </g>
                ))}
                {face.brows.map((b, i) => (
                  <path key={i} data-part="brow" d={b.d} fill="none" stroke={LINE} strokeWidth="6.5" strokeLinecap="round" />
                ))}
                <path
                  id={`${id}-mouth`}
                  data-part="mouth"
                  d={face.mouth.d}
                  fill="#2e1714"
                  stroke={LINE}
                  strokeWidth="2.4"
                  strokeLinejoin="round"
                />
                <g clipPath={`url(#${id}-mouth-clip)`}>
                  <ellipse data-part="tongue" {...face.tongue} fill="#b8695e" />
                  <rect data-part="teeth" {...face.teeth} fill="#fffaf2" />
                </g>
                <g data-part="sweat" {...face.sweat}>
                  <path d="M0,-13 C5,-5 9,0 9,5 A9,9 0 0 1 -9,5 C-9,0 -5,-5 0,-13 Z" fill="#a8dcf5" stroke={LINE} strokeWidth="2.2" />
                  <path d="M-4,3 Q-4,-1 -1,-4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
