/* Bunky's expressions, and how to get from any one to any other.
 *
 * A pose is plain numbers (drawn by bunkyFace.js), so any two poses can be
 * blended: every number is tweened, with brows leading, pupils darting,
 * the mouth following a beat later, a blink to hide big eye changes, and
 * overshoot when the target is a high-energy reaction. */

import { clamp01, lerp } from './bunkyFace.js';

/* ---------- Authoring helpers ---------- */

// Brows are cubic beziers drawn left to right. y is the brow's height,
// inner/outer push its inner (nose-side) and outer end down (negative = up),
// arch bows its middle up. dx slides it sideways.
function browL({ y = 86, inner = 0, outer = 0, arch = 4, dx = 0 } = {}) {
  const [x0, x1, y0, y1] = [64 + dx, 124 + dx, y + outer, y + inner];
  return [x0, y0, x0 + 20, lerp(y0, y1, 1 / 3) - arch * 1.33, x0 + 40, lerp(y0, y1, 2 / 3) - arch * 1.33, x1, y1];
}
function browR({ y = 86, inner = 0, outer = 0, arch = 4, dx = 0 } = {}) {
  const [x0, x1, y0, y1] = [160 + dx, 220 + dx, y + inner, y + outer];
  return [x0, y0, x0 + 20, lerp(y0, y1, 1 / 3) - arch * 1.33, x0 + 40, lerp(y0, y1, 2 / 3) - arch * 1.33, x1, y1];
}
const brows = (opts) => ({ browL: browL(opts), browR: browR(opts) });

// The mouth is a closed shape: a top curve from the left corner to the
// right, then a bottom curve back. top/bottom are where each curve's middle
// sits relative to the corners (positive = lower), so a smile has both
// positive, a frown both negative, and an open mouth has them far apart.
// skew raises (negative) the right corner, wave makes it wobbly, hx is how
// far in the curve handles sit (0 makes an O).
function mouth({ x = 143, y = 196, w = 40, top = 0, bottom = 4, skew = 0, wave = 0, hx = 0.28 } = {}) {
  const [lx, rx, ly, ry] = [x - w / 2, x + w / 2, y, y + skew];
  const ends = 0.125 * (ly + ry);
  const avg = (ly + ry) / 2;
  const kt = (avg + top - ends) / 0.75;
  const kb = (avg + bottom - ends) / 0.75;
  const h = w * hx;
  return [lx, ly, lx + h, kt + wave, rx - h, kt - wave, rx, ry, rx - h, kb - wave, lx + h, kb + wave];
}

// [top, bottom, tilt, arch] for both eyes; see lidGeometry() in bunkyFace.js.
const lids = (top = 0, bottom = 0, tilt = 0, arch = 0.3) => ({ lidL: [top, bottom, tilt, arch], lidR: [top, bottom, tilt, arch] });
const look = (dx = 0, dy = 0, r = 15) => ({ pupilL: [92 + dx, 145 + dy], pupilRt: [192 + dx, 145 + dy], pupilR: r });

const BASE = {
  ...brows({ y: 86, inner: 1, outer: 3, arch: 5 }),
  eyeScale: 1,
  ...look(4, 0),
  pupilRt: [188, 145], // a touch cross-eyed reads as looking at you
  ...lids(),
  mouth: mouth({ y: 197, w: 36, top: 2, bottom: 6.5 }),
  teeth: 0,
  blush: 0,
  sweat: 0,
  tilt: 0,
};
const pose = (overrides) => ({ ...BASE, ...overrides });

/* ---------- The expressions ---------- */

// resting: a calm face he can sit in. energy (0-1): how hard he snaps into
// it — high energy overshoots and jolts the body, low energy eases in.
export const EXPRESSIONS = {
  skeptical: {
    label: 'Skeptical (original)',
    resting: true,
    energy: 0.3,
    // Traced from the drawing, so his default face matches it exactly.
    pose: pose({
      browL: [64, 82, 85, 76, 110, 82, 125, 106],
      browR: [148, 88, 165, 93, 192, 90, 226, 86],
      pupilL: [105, 143],
      pupilRt: [181, 143],
      mouth: [117, 203, 128, 190, 156, 186, 170, 200, 158, 193, 129, 196],
    }),
  },
  neutral: { label: 'Neutral', resting: true, energy: 0.2, pose: pose({}) },
  content: {
    label: 'Content',
    resting: true,
    energy: 0.15,
    pose: pose({
      ...brows({ y: 86, inner: 1, outer: 4, arch: 6 }),
      ...lids(0.14),
      ...look(4, 2),
      pupilRt: [188, 147],
      mouth: mouth({ y: 194, w: 44, top: 5, bottom: 10 }),
      blush: 0.15,
    }),
  },
  chill: {
    label: 'Chill',
    resting: true,
    energy: 0.1,
    pose: pose({
      ...brows({ y: 90, inner: 1, outer: 4, arch: 2 }),
      ...lids(0.38, 0.06),
      ...look(8, 5, 14),
      mouth: mouth({ y: 198, w: 40, top: 1, bottom: 5, skew: -5 }),
      tilt: 2,
    }),
  },
  curious: {
    label: 'Curious',
    resting: true,
    energy: 0.25,
    pose: pose({
      browL: browL({ y: 76, inner: 0, outer: 4, arch: 9 }),
      browR: browR({ y: 88, inner: 2, outer: 2, arch: 3 }),
      ...look(10, -7),
      mouth: mouth({ y: 199, w: 24, top: 0, bottom: 4 }),
      tilt: -4,
    }),
  },
  attentive: {
    label: 'Attentive',
    resting: true,
    energy: 0.3,
    pose: pose({
      ...brows({ y: 78, inner: 1, outer: 3, arch: 7 }),
      eyeScale: 1.06,
      ...look(3, 0, 16),
      pupilRt: [189, 145],
      mouth: mouth({ y: 196, w: 30, top: 3, bottom: 7.5 }),
    }),
  },
  sleepy: {
    label: 'Sleepy',
    resting: true,
    energy: 0.05,
    pose: pose({
      ...brows({ y: 92, inner: -2, outer: 6, arch: 2 }),
      ...lids(0.56, 0.12, -6),
      ...look(2, 11, 14),
      pupilRt: [190, 156],
      mouth: mouth({ y: 202, w: 16, top: -4, bottom: 5, hx: 0.1 }),
      tilt: 5,
    }),
  },
  dreamy: {
    label: 'Dreamy',
    resting: true,
    energy: 0.1,
    pose: pose({
      ...brows({ y: 82, inner: -3, outer: 4, arch: 6 }),
      ...lids(0.3, 0.05, -4),
      ...look(4, -9, 16),
      pupilRt: [188, 136],
      mouth: mouth({ y: 195, w: 38, top: 5, bottom: 9.5 }),
      blush: 0.35,
      tilt: -3,
    }),
  },
  unimpressed: {
    label: 'Unimpressed',
    resting: true,
    energy: 0.15,
    pose: pose({
      ...brows({ y: 92, inner: 2, outer: 2, arch: 0 }),
      ...lids(0.45, 0.08),
      ...look(0, 7),
      mouth: mouth({ y: 199, w: 34, top: -1.5, bottom: 2.5 }),
    }),
  },

  happy: {
    label: 'Happy',
    energy: 0.5,
    pose: pose({
      ...brows({ y: 80, inner: 0, outer: 3, arch: 8 }),
      ...lids(0, 0.3, 0, 0.45),
      ...look(2, -7, 14),
      pupilRt: [190, 138],
      mouth: mouth({ y: 190, w: 56, top: 7, bottom: 13 }),
      blush: 0.45,
    }),
  },
  laughing: {
    label: 'Laughing',
    energy: 0.7,
    pose: pose({
      ...brows({ y: 76, inner: -2, outer: 3, arch: 9 }),
      ...lids(0, 0.32, 0, 0.7),
      ...look(0, -10, 0),
      mouth: mouth({ y: 188, w: 62, top: 5, bottom: 32, hx: 0.2 }),
      teeth: 1,
      blush: 0.6,
      tilt: -5,
    }),
  },
  excited: {
    label: 'Excited',
    energy: 0.8,
    pose: pose({
      ...brows({ y: 70, inner: 0, outer: 4, arch: 10 }),
      eyeScale: 1.1,
      ...look(1, -2, 17),
      pupilRt: [191, 143],
      mouth: mouth({ y: 190, w: 54, top: 4, bottom: 26, hx: 0.22 }),
      teeth: 0.8,
      blush: 0.3,
    }),
  },
  love: {
    label: 'Smitten',
    energy: 0.45,
    pose: pose({
      ...brows({ y: 80, inner: -3, outer: 3, arch: 7 }),
      ...lids(0.1, 0.25, 0, 0.45),
      ...look(2, -3, 18),
      pupilRt: [190, 142],
      mouth: mouth({ y: 192, w: 46, top: 6, bottom: 11 }),
      blush: 1,
      tilt: -4,
    }),
  },
  surprised: {
    label: 'Surprised',
    energy: 0.9,
    pose: pose({
      ...brows({ y: 68, inner: 2, outer: 6, arch: 10 }),
      eyeScale: 1.13,
      ...look(0, 1, 9.5),
      mouth: mouth({ y: 208, w: 22, top: -14, bottom: 14, hx: 0 }),
    }),
  },
  shocked: {
    label: 'Shocked',
    energy: 1,
    pose: pose({
      ...brows({ y: 60, inner: 2, outer: 8, arch: 12 }),
      eyeScale: 1.2,
      ...look(0, 1, 6),
      mouth: mouth({ y: 210, w: 30, top: -18, bottom: 22, hx: 0 }),
      sweat: 0.7,
    }),
  },
  sad: {
    label: 'Sad',
    energy: 0.2,
    pose: pose({
      ...brows({ y: 86, inner: -14, outer: 8, arch: 1 }),
      ...lids(0.2, 0, -14),
      ...look(0, 9),
      mouth: mouth({ y: 206, w: 36, top: -7, bottom: -2.5 }),
    }),
  },
  worried: {
    label: 'Worried',
    energy: 0.35,
    pose: pose({
      ...brows({ y: 84, inner: -14, outer: 4, arch: 2 }),
      ...lids(0.08, 0.05, -8),
      ...look(-6, 1, 13),
      mouth: mouth({ y: 202, w: 38, top: -1, bottom: 3.5, wave: 4 }),
      sweat: 0.9,
    }),
  },
  angry: {
    label: 'Angry',
    energy: 0.7,
    pose: pose({
      ...brows({ y: 92, inner: 12, outer: -6, arch: -2 }),
      ...lids(0.28, 0.08, 22),
      ...look(4, 5, 12),
      pupilRt: [188, 150],
      mouth: mouth({ y: 204, w: 34, top: -6, bottom: -2 }),
    }),
  },
  confused: {
    label: 'Confused',
    energy: 0.3,
    pose: pose({
      browL: browL({ y: 76, inner: -2, outer: 4, arch: 8 }),
      browR: browR({ y: 92, inner: 6, outer: 0, arch: 0 }),
      ...look(-8, -7, 14),
      mouth: mouth({ x: 148, y: 200, w: 32, top: -1, bottom: 3.5, wave: 4, skew: -4 }),
      tilt: 7,
    }),
  },
  smug: {
    label: 'Smug',
    energy: 0.3,
    pose: pose({
      browL: browL({ y: 80, inner: 0, outer: 4, arch: 7 }),
      browR: browR({ y: 90, inner: 4, outer: 2, arch: 2 }),
      ...lids(0.36, 0.05, 6),
      ...look(8, 5, 14),
      mouth: mouth({ x: 146, y: 198, w: 42, top: 2, bottom: 6, skew: -9 }),
      tilt: -4,
    }),
  },
  thinking: {
    label: 'Thinking',
    energy: 0.2,
    pose: pose({
      browL: browL({ y: 88, inner: 3, outer: 2, arch: 2 }),
      browR: browR({ y: 76, inner: 0, outer: 4, arch: 8 }),
      ...look(12, -11, 14),
      mouth: mouth({ x: 156, y: 200, w: 20, top: -1, bottom: 3, skew: -2 }),
      tilt: -4,
    }),
  },
  disgusted: {
    label: 'Disgusted',
    energy: 0.45,
    pose: pose({
      ...brows({ y: 92, inner: 8, outer: -2, arch: -1 }),
      ...lids(0.12, 0.3, 8, 0.25),
      ...look(-2, 5, 13),
      mouth: mouth({ y: 204, w: 40, top: -6, bottom: -1.5, wave: 4, skew: -5 }),
      tilt: 4,
    }),
  },
  embarrassed: {
    label: 'Embarrassed',
    energy: 0.3,
    pose: pose({
      ...brows({ y: 86, inner: -11, outer: 4, arch: 2 }),
      ...lids(0.12, 0.1, -6),
      ...look(-8, 9, 13),
      mouth: mouth({ y: 198, w: 30, top: 2, bottom: 6, wave: 2.5 }),
      blush: 1,
      sweat: 0.5,
      tilt: 4,
    }),
  },
  nervous: {
    label: 'Nervous',
    energy: 0.4,
    pose: pose({
      ...brows({ y: 82, inner: -12, outer: 3, arch: 2 }),
      ...look(0, 1, 11),
      mouth: mouth({ y: 200, w: 56, top: -3, bottom: 9, wave: 2.5, hx: 0.2 }),
      teeth: 1,
      sweat: 1,
    }),
  },
};

export const RESTING = Object.keys(EXPRESSIONS).filter((k) => EXPRESSIONS[k].resting);
export const REACTIONS = Object.keys(EXPRESSIONS).filter((k) => !EXPRESSIONS[k].resting);

/** A name or a pose object → { pose, energy }. */
export function resolveExpression(expression) {
  if (typeof expression === 'string') {
    const found = EXPRESSIONS[expression];
    if (!found) throw new Error(`Unknown Bunky expression "${expression}"`);
    return found;
  }
  return { pose: expression, energy: 0.3 };
}

/* ---------- Transitions ---------- */

const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (c) => (t) => 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;

// Parts move in groups, each starting a little after the last.
const GROUPS = [
  { keys: ['browL', 'browR'], delay: 0, kind: 'snappy' },
  { keys: ['pupilL', 'pupilRt'], delay: 0.03, kind: 'dart' },
  { keys: ['eyeScale', 'lidL', 'lidR', 'pupilR'], delay: 0.06, kind: 'snappy' },
  { keys: ['mouth', 'teeth'], delay: 0.12, kind: 'soft' },
  { keys: ['blush', 'sweat', 'tilt'], delay: 0, kind: 'smooth' },
];
const MAX_DELAY = 0.12;

const mixValue = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => lerp(v, b[i], t)) : lerp(a, b, t));
const sumDiff = (a, b) => (Array.isArray(a) ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) : Math.abs(a - b));

/** How different the eyes are, roughly 0 (same) to 2+ (very). */
function eyeChange(a, b) {
  return (
    (sumDiff(a.lidL.slice(0, 2), b.lidL.slice(0, 2)) + sumDiff(a.lidR.slice(0, 2), b.lidR.slice(0, 2))) / 2 +
    Math.abs(a.eyeScale - b.eyeScale) * 4 +
    Math.abs(a.pupilR - b.pupilR) / 8
  );
}

/** How different two poses are overall, roughly 0 to 1. */
function poseDistance(a, b) {
  const d =
    (sumDiff(a.browL, b.browL) + sumDiff(a.browR, b.browR)) / 120 +
    sumDiff(a.mouth, b.mouth) / 120 +
    (sumDiff(a.pupilL, b.pupilL) + sumDiff(a.pupilRt, b.pupilRt)) / 40 +
    eyeChange(a, b) / 2 +
    Math.abs(a.tilt - b.tilt) / 10;
  return clamp01(d / 2.5);
}

/**
 * Decides how a transition plays. blink: 'auto' | true | false.
 * Returns { duration (ms), blink (bool), overshoot (0 = none) }.
 */
export function planTransition(from, to, { blink = 'auto', speed = 1 } = {}) {
  const a = resolveExpression(from);
  const b = resolveExpression(to);
  const energy = b.energy;
  const dist = poseDistance(a.pose, b.pose);
  const duration = (lerp(620, 300, energy) * (0.55 + 0.45 * dist)) / speed;
  // Calm changes blink to hide big eye changes; reactions pop eyes open instead.
  const autoBlink = energy < 0.6 && eyeChange(a.pose, b.pose) > 0.35;
  return { duration, blink: blink === 'auto' ? autoBlink : blink, overshoot: energy >= 0.45 ? 1.7 * energy : 0, energy };
}

/** Lid values for a blink at progress b (0 open, 1 shut). */
export function withBlink(p, b) {
  if (b <= 0) return p;
  const close = (lid) => [lerp(lid[0], 0.56, b), lerp(lid[1], 0.5, b), lid[2] * (1 - b), lid[3]];
  return { ...p, lidL: close(p.lidL), lidR: close(p.lidR) };
}

/** The pose t (0-1) of the way through a transition planned by planTransition(). */
export function blendPose(from, to, t, plan) {
  const out = {};
  const ease = {
    snappy: plan.overshoot ? easeOutBack(plan.overshoot) : easeInOut,
    dart: plan.overshoot ? easeOutCubic : easeInOut,
    soft: plan.overshoot ? easeOutBack(plan.overshoot * 0.6) : easeInOut,
    smooth: easeInOut,
  };
  for (const { keys, delay, kind } of GROUPS) {
    const local = clamp01((t - delay) / (1 - MAX_DELAY));
    const k = ease[kind](local);
    for (const key of keys) out[key] = mixValue(from[key], to[key], k);
  }
  // Lids and teeth can't overshoot past closed/open.
  for (const key of ['lidL', 'lidR']) out[key] = out[key].map((v, i) => (i < 2 ? clamp01(v) : v));
  out.teeth = clamp01(out.teeth);
  out.sweat = clamp01(out.sweat);
  out.blush = clamp01(out.blush);
  out.pupilR = Math.max(0, out.pupilR);
  // Shut around a third of the way in, while the eyes change behind the lids.
  return plan.blink ? withBlink(out, Math.sin(Math.PI * clamp01((t - 0.05) / 0.5))) : out;
}
