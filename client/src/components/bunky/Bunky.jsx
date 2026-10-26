import { useEffect, useId, useImperativeHandle, useRef } from 'react';
import bodyUrl from './bunky-body.webp';

/* Bunky, animatable. The body is the original drawing with its face painted
 * out (assets/bunky-anim/make-body.py, saved here as WebP); the face is SVG
 * drawn on top, in the drawing's 294x270 coordinates, so it can move.
 *
 * Triggers, through a ref:
 *   const bunky = useRef(null);
 *   <Bunky ref={bunky} size={48} />
 *   bunky.current.hop();
 *   bunky.current.surprise();                   // pop, hold, settle back
 *   bunky.current.surprise({ hold: Infinity }); // stay surprised...
 *   bunky.current.relax();                      // ...until this
 * Each returns a promise that resolves when that animation ends (or is
 * interrupted by another one of the same kind). */

const LINE = '#3b211e';
const PUPIL = '#4b2a28';
const EYES = [[92, 145], [192, 145]];
const VIEW_W = 294;
const VIEW_H = 280; // drawing plus room for the ground shadow

// Brows: cubic bezier [x0,y0, c1x,c1y, c2x,c2y, x1,y1].
// Mouth: closed shape, top curve L→R then bottom curve R→L:
//   [Lx,Ly, t1x,t1y, t2x,t2y, Rx,Ry, b1x,b1y, b2x,b2y].
const SKEPTICAL = {
  browL: [64, 82, 85, 76, 110, 82, 125, 106],
  browR: [148, 88, 165, 93, 192, 90, 226, 86],
  eyeScale: 1,
  pupilR: 15,
  pupilL: [105, 143],
  pupilRt: [181, 143],
  mouth: [117, 203, 128, 190, 156, 186, 170, 200, 158, 193, 129, 196],
};
const SURPRISED = {
  browL: [68, 74, 80, 60, 106, 58, 122, 70],
  browR: [154, 70, 170, 58, 198, 60, 216, 74],
  eyeScale: 1.13,
  pupilR: 9.5,
  pupilL: [92, 146],
  pupilRt: [192, 146],
  mouth: [132, 207, 132, 190, 154, 190, 154, 207, 154, 229, 132, 229],
};

const POP_MS = 260;
const RETURN_MS = 550;
const DEFAULT_HOLD_MS = 1400;
const HOP_MS = 1150;
const JOLT_MS = 520;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeOutBack = (t) => 1 + 3.2 * (t - 1) ** 3 + 2.2 * (t - 1) ** 2;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

function mix(a, b, t) {
  const out = {};
  for (const k in a) out[k] = Array.isArray(a[k]) ? a[k].map((v, i) => lerp(v, b[k][i], t)) : lerp(a[k], b[k], t);
  return out;
}

/** SVG attributes for every face part, for a pose. */
function faceAttrs(p) {
  const m = p.mouth;
  // Midpoints of the mouth's two curves; the tongue grows in as they part.
  const top = 0.125 * (m[1] + m[7]) + 0.375 * (m[3] + m[5]);
  const bottom = 0.125 * (m[1] + m[7]) + 0.375 * (m[9] + m[11]);
  const open = clamp01((bottom - top - 8) / 20);
  return {
    eye: { r: 38 * p.eyeScale },
    pupils: [p.pupilL, p.pupilRt].map(([cx, cy]) => ({ cx, cy, r: p.pupilR })),
    glints: [p.pupilL, p.pupilRt].map(([x, y]) => ({
      cx: x - p.pupilR * 0.45,
      cy: y - p.pupilR * 0.45,
      r: Math.max(2.4, p.pupilR * 0.24),
    })),
    brows: [p.browL, p.browR].map((b) => ({ d: `M${b[0]},${b[1]} C${b[2]},${b[3]} ${b[4]},${b[5]} ${b[6]},${b[7]}` })),
    mouth: {
      d: `M${m[0]},${m[1]} C${m[2]},${m[3]} ${m[4]},${m[5]} ${m[6]},${m[7]} C${m[8]},${m[9]} ${m[10]},${m[11]} ${m[0]},${m[1]} Z`,
    },
    tongue: { cx: (m[0] + m[6]) / 2, cy: bottom - 2, rx: 11 * open, ry: 7 * open },
  };
}

function setAttrs(el, attrs) {
  for (const k in attrs) el.setAttribute(k, attrs[k]);
}

// Hop: squash, stretch up, hang, stretch down, squash on landing, wobble.
const HOP_BODY = [
  // offset, y, scaleX, scaleY, easing into the next keyframe
  [0, 0, 1, 1, 'ease-in-out'],
  [0.16, 0, 1.14, 0.84, 'cubic-bezier(.3, 0, .6, 1)'],
  [0.26, -42, 0.88, 1.15, 'cubic-bezier(.2, .6, .35, 1)'],
  [0.46, -118, 0.98, 1.02, 'cubic-bezier(.55, 0, .8, .4)'],
  [0.67, -22, 0.91, 1.11, 'linear'],
  [0.73, 0, 1.2, 0.79, 'ease-out'],
  [0.84, 0, 0.95, 1.06, 'ease-in-out'],
  [0.93, 0, 1.02, 0.98, 'ease-in-out'],
  [1, 0, 1, 1],
];
// The face lags a beat behind the body, so he reads as squishy.
const HOP_FACE = [[0, 0], [0.16, 7], [0.26, 10], [0.46, -5], [0.67, -6], [0.76, 9], [0.88, -2], [1, 0]];
// Eyes glance up at the top of the hop.
const HOP_PUPILS = [[0, 0], [0.22, 0], [0.42, -7], [0.6, -5], [0.74, 3], [1, 0]];
const HOP_SHADOW = [[0, 1, 1, 0.28], [0.16, 1.12, 1, 0.32], [0.46, 0.55, 0.7, 0.12], [0.73, 1.18, 1, 0.32], [1, 1, 1, 0.28]];
// Surprise: a quick jump-stretch, then a wobble.
const JOLT = [[0, 0, 1, 1], [0.2, -14, 0.95, 1.07], [0.45, 0, 1.05, 0.94], [0.7, 0, 0.98, 1.03], [1, 0, 1, 1]];

const squashKeyframes = (rows) =>
  rows.map(([offset, y, sx, sy, easing = 'ease-in-out']) => ({
    offset,
    easing,
    transform: `translate(0px, ${y}px) scale(${sx}, ${sy})`,
  }));
const KEYFRAMES = {
  hop: squashKeyframes(HOP_BODY),
  face: HOP_FACE.map(([offset, y]) => ({ offset, transform: `translate(0px, ${y}px)` })),
  pupils: HOP_PUPILS.map(([offset, y]) => ({ offset, transform: `translate(0px, ${y}px)` })),
  shadow: HOP_SHADOW.map(([offset, sx, sy, opacity]) => ({ offset, opacity, transform: `scale(${sx}, ${sy})` })),
  jolt: squashKeyframes(JOLT),
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const settled = (animations) => Promise.all(animations.map((a) => a.finished)).then(() => {}, () => {});

export function Bunky({ ref, size = 64, shadow = true, className = '', title = 'Bunky' }) {
  const id = `bunky-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef(null);
  // Animation bookkeeping, outside React state: the face redraws every frame.
  const anim = useRef({ face: SKEPTICAL, raf: 0, finishFace: null, hop: [], jolt: [] });

  useEffect(() => {
    const a = anim.current;
    return () => {
      cancelAnimationFrame(a.raf);
      [...a.hop, ...a.jolt].forEach((x) => x.cancel());
    };
  }, []);

  useImperativeHandle(ref, () => {
    const part = (name) => svgRef.current.querySelector(`[data-part="${name}"]`);
    const parts = (name) => svgRef.current.querySelectorAll(`[data-part="${name}"]`);

    function drawFace(p) {
      const attrs = faceAttrs(p);
      parts('eye').forEach((el) => setAttrs(el, attrs.eye));
      parts('pupil').forEach((el, i) => setAttrs(el, attrs.pupils[i]));
      parts('glint').forEach((el, i) => setAttrs(el, attrs.glints[i]));
      parts('brow').forEach((el, i) => setAttrs(el, attrs.brows[i]));
      setAttrs(part('mouth'), attrs.mouth);
      setAttrs(part('tongue'), attrs.tongue);
    }

    /** Runs poseAt(ms) every frame for totalMs; replaces any face animation
     * already running (whose promise then resolves). */
    function playFace(poseAt, totalMs) {
      const a = anim.current;
      cancelAnimationFrame(a.raf);
      a.finishFace?.();
      return new Promise((resolve) => {
        a.finishFace = () => {
          a.finishFace = null;
          resolve();
        };
        let start = null;
        const tick = (now) => {
          start ??= now;
          const ms = Math.min(now - start, totalMs);
          a.face = poseAt(ms);
          drawFace(a.face);
          if (ms < totalMs) a.raf = requestAnimationFrame(tick);
          else a.finishFace?.();
        };
        a.raf = requestAnimationFrame(tick);
      });
    }

    function hop() {
      const a = anim.current;
      a.hop.forEach((x) => x.cancel());
      if (reducedMotion()) return Promise.resolve();
      const opts = { duration: HOP_MS };
      a.hop = [
        part('hop').animate(KEYFRAMES.hop, opts),
        part('face').animate(KEYFRAMES.face, opts),
        part('pupils').animate(KEYFRAMES.pupils, opts),
        ...(shadow ? [part('shadow').animate(KEYFRAMES.shadow, opts)] : []),
      ];
      return settled(a.hop);
    }

    function surprise({ hold = DEFAULT_HOLD_MS } = {}) {
      const a = anim.current;
      const reduce = reducedMotion();
      if (!reduce) {
        a.jolt.forEach((x) => x.cancel());
        a.jolt = [part('jolt').animate(KEYFRAMES.jolt, { duration: JOLT_MS })];
      }
      const from = a.face;
      const pop = reduce ? 0 : POP_MS;
      const back = reduce ? 0 : RETURN_MS;
      const poseAt = (ms) => {
        if (ms < pop) {
          const t = ms / pop;
          // Brows and eyes overshoot; the mouth and pupils just pop.
          const p = mix(from, SURPRISED, easeOutBack(t));
          p.mouth = from.mouth.map((v, i) => lerp(v, SURPRISED.mouth[i], easeOutCubic(t)));
          p.pupilR = lerp(from.pupilR, SURPRISED.pupilR, easeOutCubic(t));
          return p;
        }
        if (ms < pop + hold) return SURPRISED;
        if (!back) return SKEPTICAL;
        return mix(SURPRISED, SKEPTICAL, easeInOut(clamp01((ms - pop - hold) / back)));
      };
      return playFace(poseAt, hold === Infinity ? pop : pop + hold + back);
    }

    function relax() {
      const from = anim.current.face;
      const back = reducedMotion() ? 0 : RETURN_MS;
      return playFace((ms) => (back ? mix(from, SKEPTICAL, easeInOut(ms / back)) : SKEPTICAL), back);
    }

    return { hop, surprise, relax };
  }, [shadow]);

  const face = faceAttrs(SKEPTICAL);
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
        <clipPath id={`${id}-mouth-clip`}>
          <use href={`#${id}-mouth`} />
        </clipPath>
      </defs>
      {shadow && <ellipse data-part="shadow" className="bunky-shadow" cx="147" cy="268" rx="112" ry="9" fill={LINE} opacity="0.28" />}
      <g data-part="hop" className="bunky-squash">
        <g data-part="jolt" className="bunky-squash">
          <image href={bodyUrl} width="294" height="270" />
          <g data-part="face" className="bunky-part" filter={`url(#${id}-crayon)`}>
            {EYES.map(([cx, cy]) => (
              <circle key={cx} data-part="eye" cx={cx} cy={cy} r={face.eye.r} fill="#fff" stroke={LINE} strokeWidth="2.8" />
            ))}
            <g data-part="pupils" className="bunky-part">
              {face.pupils.map((p, i) => (
                <g key={i}>
                  <circle data-part="pupil" {...p} fill={PUPIL} />
                  <circle data-part="glint" {...face.glints[i]} fill="#fff" />
                </g>
              ))}
            </g>
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
            {/* Tongue, clipped to the mouth so it only shows once it opens. */}
            <ellipse data-part="tongue" {...face.tongue} fill="#b8695e" clipPath={`url(#${id}-mouth-clip)`} />
          </g>
        </g>
      </g>
    </svg>
  );
}
