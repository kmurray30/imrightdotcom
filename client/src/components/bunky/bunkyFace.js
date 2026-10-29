/* Bunky's face rig: turns a pose (plain numbers, see expressions.js) into
 * SVG attributes. Everything is in the body drawing's 294x270 coordinates.
 * Bunky.jsx renders the first frame from these; bunkyController.js redraws
 * every animation frame straight into the DOM with drawFace(). */

export const LINE = '#3b211e';
export const PUPIL = '#4b2a28';
export const EYES = [[92, 145], [192, 145]];
const EYE_R = 38;
const ORIGIN = [147, 266]; // his bottom-centre, the pivot for tilts and squashes

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * One eyelid pair, clipped to the eye later. lid = [top, bottom, tilt, arch]:
 * top/bottom are how much of the eye each lid covers (0 open, ~0.5 meets in
 * the middle); tilt (degrees) drops the top lid's inner corner, so positive
 * reads angry and negative reads sad or sleepy; arch bows the bottom lid's
 * edge upward, which is what makes squinty happy eyes.
 */
function lidGeometry(cx, cy, r, [top, bottom, tilt, arch], inward) {
  const slope = Math.tan((tilt * Math.PI) / 180) * inward;
  const xl = cx - r - 2;
  const xr = cx + r + 2;
  const fill = [];
  const lines = [];

  if (top > 0.015) {
    const base = cy - r - 3 + top * (2 * r + 6);
    const bow = 0.14 * r * clamp01(top / 0.12);
    const yl = base + slope * (xl - cx);
    const yr = base + slope * (xr - cx);
    const edge = `Q${cx},${base + 2 * bow} `;
    fill.push(`M${xl},${cy - r - 12} L${xr},${cy - r - 12} L${xr},${yr} ${edge}${xl},${yl} Z`);
    lines.push(`M${xl},${yl} ${edge}${xr},${yr}`);
  }
  if (bottom > 0.015) {
    const base = cy + r + 3 - bottom * (2 * r + 6);
    const lift = arch * r * clamp01(bottom / 0.12);
    const edge = `Q${cx},${base - 2 * lift} `;
    fill.push(`M${xl},${cy + r + 12} L${xr},${cy + r + 12} L${xr},${base} ${edge}${xl},${base} Z`);
    lines.push(`M${xl},${base} ${edge}${xr},${base}`);
  }
  // An empty path clips everything away, so a fully open eye gets an
  // off-canvas sliver instead.
  return { fill: fill.join(' ') || 'M-10,-10 h1 v1 Z', line: lines.join(' ') || 'M0,0' };
}

/** SVG attributes for every face part, for a pose. */
export function faceAttrs(p) {
  const r = EYE_R * p.eyeScale;
  const m = p.mouth;
  // Midpoints of the mouth's two curves.
  const top = 0.125 * (m[1] + m[7]) + 0.375 * (m[3] + m[5]);
  const bottom = 0.125 * (m[1] + m[7]) + 0.375 * (m[9] + m[11]);
  const open = clamp01((bottom - top - 8) / 20);
  const mouthTop = Math.min(m[1], m[7], top);
  const lids = EYES.map(([cx, cy], i) => lidGeometry(cx, cy, r, i ? p.lidR : p.lidL, i ? -1 : 1));

  return {
    pose: { transform: `rotate(${p.tilt} ${ORIGIN[0]} ${ORIGIN[1]})` },
    eye: { r },
    eyeClip: { r: r + 1.6 }, // lids cover the outline too
    pupils: [p.pupilL, p.pupilRt].map(([cx, cy]) => ({ cx, cy, r: p.pupilR })),
    glints: [p.pupilL, p.pupilRt].map(([x, y]) => ({
      cx: x - p.pupilR * 0.45,
      cy: y - p.pupilR * 0.45,
      r: Math.max(0, p.pupilR * 0.25),
    })),
    lidFills: lids.map((l) => ({ d: l.fill })),
    lidLines: lids.map((l) => ({ d: l.line })),
    brows: [p.browL, p.browR].map((b) => ({ d: `M${b[0]},${b[1]} C${b[2]},${b[3]} ${b[4]},${b[5]} ${b[6]},${b[7]}` })),
    mouth: {
      d: `M${m[0]},${m[1]} C${m[2]},${m[3]} ${m[4]},${m[5]} ${m[6]},${m[7]} C${m[8]},${m[9]} ${m[10]},${m[11]} ${m[0]},${m[1]} Z`,
    },
    // The tongue grows in as the mouth opens; teeth hang from its top edge.
    tongue: { cx: (m[0] + m[6]) / 2, cy: bottom - 2, rx: 11 * open, ry: 7 * open },
    teeth: { x: m[0], y: mouthTop - 3, width: m[6] - m[0], height: top - mouthTop + 3 + 7 * p.teeth, opacity: p.teeth > 0.02 ? 1 : 0 },
    blush: { opacity: 0.5 * p.blush },
    sweat: { opacity: p.sweat, transform: `translate(228 ${112 - 8 * (1 - p.sweat)})` },
  };
}

/** Finds the elements drawFace() writes to, once per Bunky. */
export function faceParts(svg) {
  const all = (name) => [...svg.querySelectorAll(`[data-part="${name}"]`)];
  const one = (name) => svg.querySelector(`[data-part="${name}"]`);
  return {
    pose: one('pose'),
    eye: all('eye'),
    eyeClip: all('eye-clip'),
    pupils: all('pupil'),
    glints: all('glint'),
    lidFills: all('lid-fill'),
    lidLines: all('lid-line'),
    brows: all('brow'),
    mouth: one('mouth'),
    tongue: one('tongue'),
    teeth: one('teeth'),
    blush: all('blush'),
    sweat: one('sweat'),
  };
}

function set(el, attrs) {
  for (const k in attrs) el.setAttribute(k, attrs[k]);
}

export function drawFace(parts, attrs) {
  for (const key in parts) {
    const el = parts[key];
    const value = attrs[key];
    if (Array.isArray(el)) el.forEach((e, i) => set(e, Array.isArray(value) ? value[i] : value));
    else set(el, value);
  }
}
