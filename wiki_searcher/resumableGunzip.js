/**
 * A gzip decompressor that can be stopped and restarted in the middle of the
 * file without decompressing it again from the start (the technique of
 * zlib's examples/zran.c). After every deflate block it records an access
 * point: the compressed offset and bit position where the next block starts,
 * the uncompressed offset, and the last 32 KB of output (the most a deflate
 * back-reference can reach). Decompression resumes from an access point by
 * reading the compressed file from that offset.
 *
 * Built on pako's port of zlib, which (unlike Node's zlib) reports block
 * boundaries. Concatenated gzip members are followed.
 */
import ZStream from 'pako/lib/zlib/zstream.js';
import zlibInflate from 'pako/lib/zlib/inflate.js';
import zlibConstants from 'pako/lib/zlib/constants.js';

const { inflateInit2, inflate, inflateSetDictionary } = zlibInflate;
const { Z_OK, Z_STREAM_END, Z_BUF_ERROR, Z_BLOCK } = zlibConstants;
const WINDOW_SIZE = 32 * 1024;
const OUTPUT_SIZE = 1 << 20;
const GZIP = 15 + 16; // window bits: gzip wrapper
const RAW = -15; // window bits: raw deflate (resuming mid-stream)

export class ResumableGunzip {
  /**
   * @param {{ in: number, bits: number, out: number, window: Buffer } | null} [resumeFrom]
   *   An access point from an earlier run; the compressed input must then start at `startOffset`.
   */
  constructor(resumeFrom = null) {
    /** The latest access point, or null before the first block. */
    this.point = null;
    this.tail = Buffer.alloc(0); // last ≤32 KB of output
    this.trailerLeft = 0; // gzip trailer bytes still to skip after a raw-mode stream end
    this.finished = false; // past the last gzip member (only padding may follow)
    if (resumeFrom) {
      this.startOffset = resumeFrom.in - (resumeFrom.bits ? 1 : 0); // the block starts inside this byte
      this.out = resumeFrom.out;
      this.tail = Buffer.from(resumeFrom.window);
      this.start(RAW);
      if (this.tail.length) {
        const status = inflateSetDictionary(this.strm, new Uint8Array(this.tail));
        if (status !== Z_OK) throw new Error(`could not restore the decompression window (zlib status ${status})`);
      }
      this.primeBits = resumeFrom.bits;
    } else {
      this.startOffset = 0;
      this.out = 0;
      this.start(GZIP);
      this.primeBits = 0;
    }
    this.inOffset = this.startOffset; // compressed offset of the next byte pushed
  }

  start(windowBits) {
    this.strm = new ZStream();
    const status = inflateInit2(this.strm, windowBits);
    if (status !== Z_OK) throw new Error(`inflateInit2 failed (zlib status ${status})`);
    this.raw = windowBits < 0;
    this.output = new Uint8Array(OUTPUT_SIZE);
    this.outputUsed = 0;
  }

  remember(piece) {
    if (piece.length >= WINDOW_SIZE) this.tail = Buffer.from(piece.subarray(piece.length - WINDOW_SIZE));
    else {
      const joined = Buffer.concat([this.tail, piece]);
      this.tail = joined.length > WINDOW_SIZE ? Buffer.from(joined.subarray(joined.length - WINDOW_SIZE)) : joined;
    }
  }

  /**
   * Decompresses one chunk of compressed input. Yields output pieces in
   * order (views that stay valid); `this.point` is only advanced after the
   * consumer has taken the piece before it, so while a piece is being
   * consumed `point.out` never lies past that piece's start.
   */
  *push(chunk) {
    const input = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const base = this.inOffset;
    this.inOffset += input.length;
    let pos = 0;
    if (this.primeBits && input.length) {
      // inflatePrime: the bits of the first byte that belong to the block (zran.c).
      const state = this.strm.state;
      state.hold += (input[0] >> (8 - this.primeBits)) << state.bits;
      state.bits += this.primeBits;
      this.primeBits = 0;
      pos = 1;
    }
    while (pos < input.length) {
      if (this.finished) return; // zero padding after the last member
      if (this.trailerLeft) {
        const n = Math.min(this.trailerLeft, input.length - pos);
        this.trailerLeft -= n;
        pos += n;
        if (this.trailerLeft === 0) this.nextMember(input, pos);
        continue;
      }
      const strm = this.strm;
      strm.input = input;
      strm.next_in = pos;
      strm.avail_in = input.length - pos;
      strm.output = this.output;
      strm.next_out = this.outputUsed;
      strm.avail_out = this.output.length - this.outputUsed;
      const status = inflate(strm, Z_BLOCK);
      if (status !== Z_OK && status !== Z_STREAM_END && status !== Z_BUF_ERROR) {
        throw new Error(`the bundle's gzip data is corrupt at compressed byte ${base + strm.next_in}: ${strm.msg || `zlib status ${status}`}`);
      }
      pos = strm.next_in;
      const produced = strm.next_out - this.outputUsed;
      if (produced > 0) {
        const piece = Buffer.from(this.output.buffer, this.output.byteOffset + this.outputUsed, produced);
        this.outputUsed = strm.next_out;
        this.out += produced;
        this.remember(piece);
        yield piece;
      }
      if (this.outputUsed === this.output.length) {
        this.output = new Uint8Array(OUTPUT_SIZE); // earlier pieces are views of the old buffer
        this.outputUsed = 0;
      }
      if (status === Z_STREAM_END) {
        if (this.raw) this.trailerLeft = 8; // CRC32 + length; the gzip wrapper reads them itself
        else this.nextMember(input, pos);
        continue;
      }
      // At a block boundary (and not after the final block): an access point.
      if (strm.data_type & 128 && !(strm.data_type & 64)) {
        this.point = { in: base + pos, bits: strm.data_type & 7, out: this.out, window: this.tail };
      }
      if (status === Z_BUF_ERROR && strm.avail_in === 0) break;
    }
  }

  /** After a gzip member: another member, or (zero bytes) padding to the end. */
  nextMember(input, pos) {
    if (pos < input.length && input[pos] === 0) {
      this.finished = true;
      return;
    }
    this.start(GZIP);
  }
}

/** An access point as JSON (the window as base64). */
export function serializePoint(point) {
  return { in: point.in, bits: point.bits, out: point.out, window: point.window.toString('base64') };
}
export function deserializePoint(json) {
  return { in: json.in, bits: json.bits, out: json.out, window: Buffer.from(json.window, 'base64') };
}
