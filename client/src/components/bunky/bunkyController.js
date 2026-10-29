/* Drives one Bunky's SVG: expression transitions, blinks, idle life and the
 * hop. Redraws straight into the DOM (no React state) since the face
 * changes every animation frame. Bunky.jsx creates one per Bunky. */

import { drawFace, faceAttrs, faceParts } from './bunkyFace.js';
import { blendPose, planTransition, resolveExpression, withBlink } from './expressions.js';

const HOP_MS = 1150;
const JOLT_MS = 520;
const BLINK_MS = 190;
const DEFAULT_HOLD_MS = 1400;

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
// Snapping into a high-energy expression: a jump-stretch, then a wobble.
const JOLT = [[0, 0, 1, 1], [0.2, -14, 0.95, 1.07], [0.45, 0, 1.05, 0.94], [0.7, 0, 0.98, 1.03], [1, 0, 1, 1]];

const squashKeyframes = (rows, amount = 1) =>
  rows.map(([offset, y, sx, sy, easing = 'ease-in-out']) => ({
    offset,
    easing,
    transform: `translate(0px, ${y * amount}px) scale(${1 + (sx - 1) * amount}, ${1 + (sy - 1) * amount})`,
  }));
const translateKeyframes = (rows) => rows.map(([offset, y]) => ({ offset, transform: `translate(0px, ${y}px)` }));
const HOP_KEYFRAMES = {
  hop: squashKeyframes(HOP_BODY),
  face: translateKeyframes(HOP_FACE),
  pupils: translateKeyframes(HOP_PUPILS),
  shadow: HOP_SHADOW.map(([offset, sx, sy, opacity]) => ({ offset, opacity, transform: `scale(${sx}, ${sy})` })),
};
const BREATH_KEYFRAMES = [{ transform: 'scale(1, 1)' }, { transform: 'scale(0.994, 1.016)' }];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const settled = (animations) => Promise.all(animations.map((a) => a.finished)).then(() => {}, () => {});
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/**
 * @param svg      the Bunky's <svg>
 * @param initial  expression name or pose it was first rendered with
 * @param getBase  returns the expression to settle back to (the prop)
 */
export function createBunkyController(svg, { initial, getBase }) {
  const parts = faceParts(svg);
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);
  const hasShadow = () => Boolean(part('shadow'));

  const state = {
    face: resolveExpression(initial).pose,
    blink: 0, // overlays the face; 1 = shut
    gaze: [0, 0], // overlays the pupils
    raf: 0,
    finishFace: null,
    token: 0, // bumped by every expression action, so stale chains stop
    timer: null,
    hop: [],
    jolt: [],
    blinkRaf: 0,
    gazeRaf: 0,
    idle: null,
  };

  function render() {
    let p = state.face;
    if (state.gaze[0] || state.gaze[1]) {
      const [gx, gy] = state.gaze;
      p = { ...p, pupilL: [p.pupilL[0] + gx, p.pupilL[1] + gy], pupilRt: [p.pupilRt[0] + gx, p.pupilRt[1] + gy] };
    }
    drawFace(parts, faceAttrs(withBlink(p, state.blink)));
  }

  /** Runs frame(progress 0-1) for ms; replaces any face animation already
   * running (whose promise then resolves). */
  function animateFace(ms, frame) {
    cancelAnimationFrame(state.raf);
    state.finishFace?.();
    return new Promise((resolve) => {
      state.finishFace = () => {
        state.finishFace = null;
        resolve();
      };
      let start = null;
      const tick = (now) => {
        start ??= now;
        const t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
        frame(t);
        render();
        if (t < 1) state.raf = requestAnimationFrame(tick);
        else state.finishFace?.();
      };
      state.raf = requestAnimationFrame(tick);
    });
  }

  function jolt(energy) {
    if (reducedMotion() || energy < 0.6) return;
    state.jolt.forEach((a) => a.cancel());
    state.jolt = [part('jolt').animate(squashKeyframes(JOLT, (energy - 0.4) / 0.6), { duration: JOLT_MS })];
  }

  function transition(from, to, opts = {}) {
    const plan = planTransition(from, to, opts);
    const a = resolveExpression(from).pose;
    const b = resolveExpression(to).pose;
    jolt(plan.energy);
    const ms = reducedMotion() ? 0 : plan.duration;
    return animateFace(ms, (t) => {
      state.face = blendPose(a, b, t, plan);
    });
  }

  function cancelPending() {
    state.token += 1;
    clearTimeout(state.timer);
    return state.token;
  }

  const api = {
    /** Animate from the current face to an expression (name or pose). */
    setExpression(to, opts) {
      cancelPending();
      return transition(state.face, to, opts);
    },

    /** Jump to `from`, then animate to `to`. */
    play(from, to, opts) {
      cancelPending();
      state.face = resolveExpression(from).pose;
      render();
      return transition(from, to, opts);
    },

    /** Go to an expression, hold it, then settle back to the base one.
     * hold: Infinity stays until another action. */
    async react(to, { hold = DEFAULT_HOLD_MS, ...opts } = {}) {
      const token = cancelPending();
      await transition(state.face, to, opts);
      if (token !== state.token || hold === Infinity) return;
      await new Promise((resolve) => {
        state.timer = setTimeout(resolve, hold);
      });
      if (token !== state.token) return;
      await transition(state.face, getBase(), opts);
    },

    surprise(opts) {
      return api.react('surprised', opts);
    },

    /** Back to the base expression. */
    relax(opts) {
      return api.setExpression(getBase(), opts);
    },

    /** Draws the frame t (0-1) of the way from one expression to another,
     * without animating; for scrubbing. */
    preview(from, to, t, opts) {
      cancelPending();
      cancelAnimationFrame(state.raf);
      state.finishFace?.();
      state.face = blendPose(resolveExpression(from).pose, resolveExpression(to).pose, t, planTransition(from, to, opts));
      render();
    },

    blink() {
      if (reducedMotion()) return Promise.resolve();
      cancelAnimationFrame(state.blinkRaf);
      return new Promise((resolve) => {
        let start = null;
        const tick = (now) => {
          start ??= now;
          const t = Math.min(1, (now - start) / BLINK_MS);
          // Snap shut, ease open.
          state.blink = t < 0.35 ? t / 0.35 : 1 - (t - 0.35) / 0.65;
          render();
          if (t < 1) state.blinkRaf = requestAnimationFrame(tick);
          else resolve();
        };
        state.blinkRaf = requestAnimationFrame(tick);
      });
    },

    hop() {
      state.hop.forEach((a) => a.cancel());
      if (reducedMotion()) return Promise.resolve();
      const opts = { duration: HOP_MS };
      state.hop = [
        part('hop').animate(HOP_KEYFRAMES.hop, opts),
        part('face').animate(HOP_KEYFRAMES.face, opts),
        part('pupils').animate(HOP_KEYFRAMES.pupils, opts),
        ...(hasShadow() ? [part('shadow').animate(HOP_KEYFRAMES.shadow, opts)] : []),
      ];
      return settled(state.hop);
    },

    /** Breathing, blinking every few seconds, and the odd glance around. */
    startIdle() {
      if (state.idle || reducedMotion()) return;
      const idle = { timers: [] };
      state.idle = idle;
      idle.breath = part('breath').animate(BREATH_KEYFRAMES, {
        duration: 1700,
        iterations: Infinity,
        direction: 'alternate',
        easing: 'ease-in-out',
      });
      const later = (fn, ms) => idle.timers.push(setTimeout(fn, ms));
      const blinkLoop = () => {
        api.blink().then(() => {
          if (Math.random() < 0.2) later(() => api.blink(), 120); // sometimes a double blink
        });
        later(blinkLoop, rand(2400, 5600));
      };
      const glanceLoop = () => {
        glance([rand(-7, 7), rand(-4, 3)], () => later(() => glance([0, 0]), rand(900, 2000)));
        later(glanceLoop, rand(4000, 9000));
      };
      later(blinkLoop, rand(800, 2500));
      later(glanceLoop, rand(2500, 5000));
    },

    stopIdle() {
      if (!state.idle) return;
      state.idle.timers.forEach(clearTimeout);
      state.idle.breath.cancel();
      state.idle = null;
      glance([0, 0]);
    },

    destroy() {
      api.stopIdle();
      cancelPending();
      [state.raf, state.blinkRaf, state.gazeRaf].forEach(cancelAnimationFrame);
      [...state.hop, ...state.jolt].forEach((a) => a.cancel());
    },
  };

  function glance(to, done) {
    cancelAnimationFrame(state.gazeRaf);
    const from = state.gaze;
    let start = null;
    const tick = (now) => {
      start ??= now;
      const t = Math.min(1, (now - start) / 140);
      const k = 1 - (1 - t) ** 3;
      state.gaze = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
      render();
      if (t < 1) state.gazeRaf = requestAnimationFrame(tick);
      else done?.();
    };
    state.gazeRaf = requestAnimationFrame(tick);
  }

  return api;
}
