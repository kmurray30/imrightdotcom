/**
 * Procedural stand-in frames so the demo page, the packer and the e2e tests
 * work end to end before any fal.ai output exists. Draws a simple brown
 * tube snake (bold outline, two eyes) as SVG and rasterises it with sharp.
 *
 * Determinism matters: slither frame 0 must equal frame N-1 byte for byte,
 * uncurl frame 0 must equal the curled hub, and uncurl frame N-1 / slither
 * frame 0 must equal the snake hub, exactly like the real hub-forced clips.
 */
import sharp from 'sharp';
import { anchorFor } from './config.js';

const BODY = '#8b5a2b';
const OUTLINE = '#3a2314';
const BODY_W = 44;
const OUTLINE_W = 54;
const EYE_R = 10;
const PUPIL_R = 4.5;
const POINTS = 48;

const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

/** Stretched-out S-curve, tail at the left, head at the right. y is "up". */
export function sCurvePoints(phase = 0) {
  const L = 250;
  const A = 26;
  const pts = [];
  for (let j = 0; j < POINTS; j++) {
    const t = j / (POINTS - 1);
    const x = -L / 2 + L * t;
    // One wave travelling down the body; head lifts a little.
    const lift = 18 * Math.max(0, t - 0.78) * 4.5;
    const y = A * Math.sin(2 * Math.PI * 1.5 * t - phase) + lift;
    pts.push([x, y]);
  }
  return pts;
}

/** Coiled pile, tail in the middle, head on top. */
export function spiralPoints() {
  const turns = 2.25; // ends at the top (θ = 4π + π/2)
  const pts = [];
  for (let j = 0; j < POINTS; j++) {
    const t = j / (POINTS - 1);
    const theta = 2 * Math.PI * turns * t;
    const r = 8 + 26 * (theta / (2 * Math.PI));
    pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  return pts;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function lerpPoints(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a.map(([ax, ay], j) => [ax + (b[j][0] - ax) * t, ay + (b[j][1] - ay) * t]);
}

/** Body points (math coords, y up) for frame i of N of a clip. */
export function placeholderPoints(clip, i, n) {
  switch (clip) {
    case 'slither':
      return sCurvePoints((2 * Math.PI * (i % (n - 1))) / (n - 1));
    case 'uncurl':
      return lerpPoints(spiralPoints(), sCurvePoints(0), easeInOut(i / (n - 1)));
    case 'curl':
      return placeholderPoints('uncurl', n - 1 - i, n);
    default:
      throw new Error(`placeholderPoints: unknown clip "${clip}"`);
  }
}

export function placeholderHubPoints(hub, n) {
  if (hub === 'curled') return placeholderPoints('uncurl', 0, n);
  if (hub === 'snake') return placeholderPoints('uncurl', n - 1, n);
  throw new Error(`placeholderHubPoints: unknown hub "${hub}"`);
}

function eyesFor(points) {
  const [hx, hy] = points[points.length - 1];
  return [
    { cx: hx - 6, cy: hy + 9 },
    { cx: hx + 10, cy: hy + 9 },
  ];
}

/** Build the SVG for a set of body points, grounded on the box anchor. */
export function pointsToSvg(points, box) {
  const anchor = anchorFor(box);
  const eyes = eyesFor(points);
  const r = OUTLINE_W / 2;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  for (const [x, y] of points) {
    xMin = Math.min(xMin, x - r);
    xMax = Math.max(xMax, x + r);
    yMin = Math.min(yMin, y - r);
  }
  for (const e of eyes) {
    xMin = Math.min(xMin, e.cx - EYE_R - 2);
    xMax = Math.max(xMax, e.cx + EYE_R + 2);
    yMin = Math.min(yMin, e.cy - EYE_R - 2);
  }
  const xMid = (xMin + xMax) / 2;
  const sx = (x) => anchor.x + (x - xMid);
  const sy = (y) => anchor.y - (y - yMin);
  const poly = points.map(([x, y]) => `${fmt(sx(x))},${fmt(sy(y))}`).join(' ');
  const eyeSvg = eyes
    .map(
      (e) =>
        `<circle cx="${fmt(sx(e.cx))}" cy="${fmt(sy(e.cy))}" r="${EYE_R}" fill="#ffffff" stroke="${OUTLINE}" stroke-width="3"/>` +
        `<circle cx="${fmt(sx(e.cx) + 2.5)}" cy="${fmt(sy(e.cy))}" r="${PUPIL_R}" fill="#1d1d1f"/>`
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.frameWidth}" height="${box.frameHeight}" viewBox="0 0 ${box.frameWidth} ${box.frameHeight}">` +
    `<polyline points="${poly}" fill="none" stroke="${OUTLINE}" stroke-width="${OUTLINE_W}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<polyline points="${poly}" fill="none" stroke="${BODY}" stroke-width="${BODY_W}" stroke-linecap="round" stroke-linejoin="round"/>` +
    eyeSvg +
    `</svg>`
  );
}

export function renderPlaceholderSvg(clip, i, n, box) {
  return pointsToSvg(placeholderPoints(clip, i, n), box);
}

export function renderPlaceholderHubSvg(hub, n, box) {
  return pointsToSvg(placeholderHubPoints(hub, n), box);
}

/** Rasterise an SVG string to raw RGBA. */
export async function rasterizeSvg(svg, box) {
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(box.frameWidth, box.frameHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function renderPlaceholderFrame(clip, i, n, box) {
  return rasterizeSvg(renderPlaceholderSvg(clip, i, n, box), box);
}

export async function renderPlaceholderHub(hub, n, box) {
  return rasterizeSvg(renderPlaceholderHubSvg(hub, n, box), box);
}
