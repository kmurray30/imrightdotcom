/** Synthetic RGBA frame builders for the pipeline unit tests. */

export function makeFrame(width, height, rgba = [0, 0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { data, width, height };
}

export function fillRect(frame, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= frame.width || yy >= frame.height) continue;
      const i = (yy * frame.width + xx) * 4;
      frame.data[i] = rgba[0];
      frame.data[i + 1] = rgba[1];
      frame.data[i + 2] = rgba[2];
      frame.data[i + 3] = rgba[3];
    }
  }
  return frame;
}

export function pixelAt(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return Array.from(frame.data.slice(i, i + 4));
}

export function countOpaque(data, threshold = 128) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > threshold) n++;
  return n;
}

export const GREEN = [0, 255, 0, 255];
export const BROWN = [139, 90, 43, 255];
export const WHITE = [255, 255, 255, 255];

/** 50/50 mix of two colours, as a camera/encoder would produce on an edge. */
export function mix(a, b) {
  return [0, 1, 2].map((k) => Math.round((a[k] + b[k]) / 2)).concat([255]);
}
