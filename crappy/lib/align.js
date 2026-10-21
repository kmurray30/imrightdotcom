/**
 * Scale normalisation and anchor alignment of keyed frames into the fixed
 * sprite box, using sharp for resize/extract/composite.
 */
import sharp from 'sharp';
import { anchorFor } from './config.js';

function toBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Pick one global scale for the hub images and derive each clip's scale from
 * it, so the character is the same size in every sheet.
 *
 * @param {object} args
 * @param {{ snake: { bbox: object }, curled: { bbox: object } }} args.hubs bboxes in hub pixel space
 * @param {Record<string, { frames: Array<{ bbox: object, anchor: {x:number,y:number} }>, videoSnakeHeight: number }>} args.clips
 *   per clip: the sampled video frames' bboxes/anchors (video pixel space) and the bbox height of
 *   the frame that shows the stretched snake pose, used to map video px onto hub px
 * @param {object} args.box frame box (frameWidth, frameHeight, margins, snakeHeightRatio)
 */
export function computeGlobalScale({ hubs, clips, box }) {
  const anchor = anchorFor(box);
  const hubSnakeHeight = hubs.snake.bbox.y1 - hubs.snake.bbox.y0 + 1;
  if (hubSnakeHeight <= 0) throw new Error('computeGlobalScale: snake hub has an empty bbox');
  const sTarget = (box.snakeHeightRatio * box.frameHeight) / hubSnakeHeight;

  // Extents relative to each frame's own anchor, expressed in hub pixels.
  let maxLeft = 0;
  let maxRight = 0;
  let maxUp = 0;
  let maxDown = 0;
  const consider = (bbox, a, k) => {
    maxLeft = Math.max(maxLeft, (a.x - bbox.x0) * k);
    maxRight = Math.max(maxRight, (bbox.x1 - a.x) * k);
    maxUp = Math.max(maxUp, (a.y - bbox.y0) * k);
    maxDown = Math.max(maxDown, (bbox.y1 - a.y) * k);
  };
  for (const hub of Object.values(hubs)) {
    const a = hub.anchor ?? { x: (hub.bbox.x0 + hub.bbox.x1) / 2, y: hub.bbox.y1 };
    consider(hub.bbox, a, 1);
  }
  const ks = {};
  for (const [name, clip] of Object.entries(clips)) {
    const k = clip.videoSnakeHeight > 0 ? hubSnakeHeight / clip.videoSnakeHeight : 1;
    ks[name] = k;
    for (const frame of clip.frames) {
      if (!frame.bbox) continue;
      consider(frame.bbox, frame.anchor, k);
    }
  }

  const limits = [];
  if (maxLeft > 0) limits.push((anchor.x - box.fitMarginX) / maxLeft);
  if (maxRight > 0) limits.push((box.frameWidth - anchor.x - box.fitMarginX) / maxRight);
  if (maxUp > 0) limits.push((anchor.y - box.fitMarginTop) / maxUp);
  if (maxDown > 0) limits.push((box.frameHeight - anchor.y) / maxDown);
  const sFit = limits.length ? Math.min(...limits) : sTarget;
  const sHub = Math.min(sTarget, sFit);

  const sClips = {};
  for (const name of Object.keys(clips)) sClips[name] = sHub * ks[name];
  return {
    sHub,
    sClips,
    snakeHeightPx: Math.round(hubSnakeHeight * sHub),
    limiting: sFit < sTarget ? 'fit' : 'target',
  };
}

export async function transparentFrame(box) {
  return sharp({
    create: {
      width: box.frameWidth,
      height: box.frameHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .raw()
    .toBuffer();
}

/**
 * Scale a keyed RGBA frame and place it so `anchor` (in source pixels) lands
 * on the box anchor. Returns raw RGBA of frameWidth × frameHeight.
 *
 * @param {{ data: Uint8Array | Buffer, width: number, height: number }} frame
 * @param {{ x: number, y: number }} anchor source-space anchor
 * @param {number} scale
 * @param {object} box
 */
export async function alignFrame(frame, anchor, scale, box) {
  const W = box.frameWidth;
  const H = box.frameHeight;
  const target = anchorFor(box);
  const sw = Math.max(1, Math.round(frame.width * scale));
  const sh = Math.max(1, Math.round(frame.height * scale));

  let resized = toBuffer(frame.data);
  if (sw !== frame.width || sh !== frame.height) {
    resized = await sharp(toBuffer(frame.data), {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })
      .resize(sw, sh, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer();
  }
  const sx = sw / frame.width;
  const sy = sh / frame.height;
  // Source rect origin (in resized coords) that puts the anchor on the target.
  const left = Math.round(anchor.x * sx - target.x);
  const top = Math.round(anchor.y * sy - target.y);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(sw, left + W);
  const y1 = Math.min(sh, top + H);
  if (x1 <= x0 || y1 <= y0) return transparentFrame(box);

  const pieceW = x1 - x0;
  const pieceH = y1 - y0;
  let piece = resized;
  if (pieceW !== sw || pieceH !== sh) {
    piece = await sharp(resized, { raw: { width: sw, height: sh, channels: 4 } })
      .extract({ left: x0, top: y0, width: pieceW, height: pieceH })
      .raw()
      .toBuffer();
  }
  if (pieceW === W && pieceH === H && x0 - left === 0 && y0 - top === 0) return piece;

  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: piece,
        raw: { width: pieceW, height: pieceH, channels: 4 },
        left: x0 - left,
        top: y0 - top,
      },
    ])
    .raw()
    .toBuffer();
}
