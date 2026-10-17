/**
 * Postgres binary COPY encoding for (id, vector) rows — 4–8x less data over
 * the wire than text literals, which matters when uploading tens of millions
 * of vectors through a tunnel. Formats, from pgvector's own recv functions
 * (vector_recv / halfvec_recv): int16 dimensions, int16 zero, then each value
 * big-endian — float4 for vector, IEEE half (raw 16 bits) for halfvec.
 */

const COPY_SIGNATURE = Buffer.from('PGCOPY\n\xff\r\n\0', 'latin1');

const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

/** IEEE 754 float32 → float16 bits, round-to-nearest-even, with subnormals; out-of-range values become ±Infinity. */
export function float32ToHalfBits(value) {
  float32[0] = value;
  const bits = uint32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // Inf / NaN
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign; // underflow → ±0
    mantissa |= 0x800000; // implicit leading 1
    const shift = 14 - halfExponent;
    let half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1))) half += 1;
    return sign | half;
  }
  let half = (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1))) half += 1; // may carry into exponent: still correct
  return sign | half;
}

/** pgvector halfvec binary value. */
export function encodeHalfvec(values) {
  const buffer = Buffer.allocUnsafe(4 + 2 * values.length);
  buffer.writeInt16BE(values.length, 0);
  buffer.writeInt16BE(0, 2);
  for (let i = 0; i < values.length; i++) buffer.writeUInt16BE(float32ToHalfBits(values[i]), 4 + 2 * i);
  return buffer;
}

/** pgvector vector (float4) binary value. */
export function encodeVector(values) {
  const buffer = Buffer.allocUnsafe(4 + 4 * values.length);
  buffer.writeInt16BE(values.length, 0);
  buffer.writeInt16BE(0, 2);
  for (let i = 0; i < values.length; i++) buffer.writeFloatBE(values[i], 4 + 4 * i);
  return buffer;
}

/**
 * Complete `COPY ... (id, <vector column>) FROM STDIN (FORMAT binary)` payload.
 * @param {Array<[number|bigint, Buffer]>} rows - id (bigint column) and an encoded vector value.
 */
export function binaryCopyPayload(rows) {
  const parts = [COPY_SIGNATURE, Buffer.alloc(8)]; // flags int32 = 0, header extension length int32 = 0
  for (const [id, value] of rows) {
    const head = Buffer.allocUnsafe(2 + 4 + 8 + 4);
    head.writeInt16BE(2, 0); // field count
    head.writeInt32BE(8, 2);
    head.writeBigInt64BE(BigInt(id), 6);
    head.writeInt32BE(value.length, 14);
    parts.push(head, value);
  }
  const trailer = Buffer.allocUnsafe(2);
  trailer.writeInt16BE(-1, 0);
  parts.push(trailer);
  return Buffer.concat(parts);
}
