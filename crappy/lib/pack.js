/**
 * Pack aligned raw RGBA frames into a grid sprite sheet.
 */
import sharp from 'sharp';

export function sheetLayout(frameCount, columns, frameWidth, frameHeight) {
  const rows = Math.max(1, Math.ceil(frameCount / columns));
  const cells = [];
  for (let i = 0; i < frameCount; i++) {
    cells.push({ left: (i % columns) * frameWidth, top: Math.floor(i / columns) * frameHeight });
  }
  return { rows, columns, sheetWidth: columns * frameWidth, sheetHeight: rows * frameHeight, cells };
}

export function sheetExtension(format) {
  return format === 'webp' ? 'webp' : 'png';
}

/**
 * @param {Buffer[]} frames raw RGBA buffers, each frameWidth × frameHeight
 * @param {{ frameWidth: number, frameHeight: number, columns: number, format?: 'png'|'webp', palette?: boolean }} opts
 */
export async function packSheet(frames, opts) {
  const { frameWidth, frameHeight, columns } = opts;
  if (frames.length === 0) throw new Error('packSheet: no frames');
  const expected = frameWidth * frameHeight * 4;
  frames.forEach((f, i) => {
    if (f.length !== expected) {
      throw new Error(`packSheet: frame ${i} has ${f.length} bytes, expected ${expected}`);
    }
  });
  const layout = sheetLayout(frames.length, columns, frameWidth, frameHeight);
  let pipeline = sharp({
    create: {
      width: layout.sheetWidth,
      height: layout.sheetHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(
    frames.map((input, i) => ({
      input,
      raw: { width: frameWidth, height: frameHeight, channels: 4 },
      left: layout.cells[i].left,
      top: layout.cells[i].top,
    }))
  );
  const format = opts.format === 'webp' ? 'webp' : 'png';
  if (format === 'webp') {
    pipeline = pipeline.webp({ lossless: true, effort: 6 });
  } else {
    pipeline = pipeline.png({
      compressionLevel: 9,
      palette: opts.palette !== false,
      colors: 256,
      dither: 0,
      effort: 10,
    });
  }
  const buffer = await pipeline.toBuffer();
  return { buffer, format, ext: sheetExtension(format), ...layout, cells: undefined };
}
