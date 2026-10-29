/**
 * Reads a tar stream and hands each entry to a handler as a readable
 * stream, one entry at a time, reporting the byte offset where each entry's
 * headers begin. That offset is what lets the bundle fetcher resume at an
 * entry boundary (see resumableGunzip.js). Understands ustar, pax ('x')
 * and GNU long-name ('L') headers; every header's checksum is verified, so
 * reading from a wrong offset fails loudly instead of producing garbage.
 */
import { PassThrough } from 'stream';
import { once } from 'events';

const BLOCK = 512;

function readString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}
function readSize(block) {
  if (block[124] & 0x80) {
    let size = 0;
    for (let i = 125; i < 136; i++) size = size * 256 + block[i];
    return size;
  }
  return parseInt(readString(block, 124, 12).trim() || '0', 8);
}
function checksumOk(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum === parseInt(readString(block, 148, 8).trim(), 8);
}
function paxPath(data) {
  let pos = 0;
  let path = null;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = parseInt(data.toString('utf8', pos, space), 10);
    if (!length) break;
    const record = data.toString('utf8', space + 1, pos + length - 1);
    if (record.startsWith('path=')) path = record.slice(5);
    pos += length;
  }
  return path;
}

export class TarWalker {
  /**
   * @param {object} options
   * @param {number} [options.offset] - uncompressed offset of the first byte written
   * @param {number} [options.skipTo] - discard bytes before this offset (resuming at an entry boundary)
   * @param {(offset: number) => Promise<void> | void} [options.onEntryStart] - an entry's first header begins at `offset`; every earlier entry is fully handled
   * @param {(header: {name: string, type: string, size: number}, stream: PassThrough) => Promise<void>} options.onEntry - must read the stream to its end
   */
  constructor({ offset = 0, skipTo = offset, onEntryStart = () => {}, onEntry }) {
    this.offset = offset;
    this.skip = skipTo - offset;
    if (this.skip < 0) throw new Error('TarWalker: skipTo is before the first byte');
    this.onEntryStart = onEntryStart;
    this.onEntry = onEntry;
    this.state = 'header';
    this.header = Buffer.alloc(BLOCK);
    this.headerFill = 0;
    this.entryStart = null; // offset of the first header of the entry being read (pax/long-name headers come first)
    this.meta = null; // { type, remaining, parts } while reading a pax / long-name header's data
    this.longName = null;
    this.paxName = null;
    this.entry = null; // { stream, remaining, handler, settled }
    this.pad = 0;
    this.ended = false;
  }

  /** Feeds bytes in order. Resolves once they are consumed (the entry handler's backpressure included). */
  async write(chunk) {
    let pos = 0;
    while (pos < chunk.length && !this.ended) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - pos);
        this.skip -= n;
        pos += n;
        this.offset += n;
        continue;
      }
      if (this.pad > 0) {
        const n = Math.min(this.pad, chunk.length - pos);
        this.pad -= n;
        pos += n;
        this.offset += n;
        continue;
      }
      if (this.state === 'header') {
        const n = Math.min(BLOCK - this.headerFill, chunk.length - pos);
        chunk.copy(this.header, this.headerFill, pos, pos + n);
        this.headerFill += n;
        pos += n;
        this.offset += n;
        if (this.headerFill === BLOCK) {
          this.headerFill = 0;
          await this.readHeader(this.offset - BLOCK);
        }
      } else if (this.state === 'meta') {
        const n = Math.min(this.meta.remaining, chunk.length - pos);
        this.meta.parts.push(Buffer.from(chunk.subarray(pos, pos + n)));
        this.meta.remaining -= n;
        pos += n;
        this.offset += n;
        if (this.meta.remaining === 0) this.finishMeta();
      } else {
        const n = Math.min(this.entry.remaining, chunk.length - pos);
        const piece = chunk.subarray(pos, pos + n);
        this.entry.remaining -= n;
        pos += n;
        this.offset += n;
        if (!this.entry.settled && !this.entry.stream.write(piece)) {
          await Promise.race([once(this.entry.stream, 'drain'), this.entry.handler]);
        }
        if (this.entry.remaining === 0) await this.finishEntry();
      }
    }
  }

  async readHeader(at) {
    const block = this.header;
    if (block.every((b) => b === 0)) {
      this.ended = true; // end-of-archive marker
      return;
    }
    if (!checksumOk(block)) throw new Error(`tar header checksum mismatch at uncompressed byte ${at}`);
    if (this.entryStart === null) {
      this.entryStart = at;
      await this.onEntryStart(at);
    }
    const type = String.fromCharCode(block[156] || 48);
    const size = readSize(block);
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      this.meta = { type, remaining: size, parts: [], size };
      this.state = 'meta';
      if (size === 0) this.finishMeta();
      return;
    }
    let name = readString(block, 0, 100);
    if (block.toString('latin1', 257, 262) === 'ustar') {
      const prefix = readString(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = this.paxName ?? this.longName ?? name;
    this.paxName = this.longName = null;
    const kind = type === '0' || type === '7' ? 'file' : type === '5' ? 'directory' : 'other';
    const stream = new PassThrough({ highWaterMark: 4 << 20 });
    const entry = { stream, remaining: size, settled: false, size };
    entry.handler = Promise.resolve(this.onEntry({ name, type: kind, size }, stream)).finally(() => (entry.settled = true));
    entry.handler.catch(() => {}); // awaited in finishEntry
    this.entry = entry;
    this.state = 'data';
    if (size === 0) await this.finishEntry();
  }

  finishMeta() {
    const data = Buffer.concat(this.meta.parts);
    if (this.meta.type === 'x') this.paxName = paxPath(data) ?? this.paxName;
    else if (this.meta.type === 'L') this.longName = readString(data, 0, data.length);
    this.pad = (BLOCK - (this.meta.size % BLOCK)) % BLOCK;
    this.meta = null;
    this.state = 'header';
  }

  async finishEntry() {
    const { stream, handler, size } = this.entry;
    stream.end();
    await handler;
    this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
    this.entry = null;
    this.entryStart = null;
    this.state = 'header';
  }

  /** The input ended: true if the archive was complete. */
  get complete() {
    return this.ended || (this.state === 'header' && this.headerFill === 0 && this.entry === null && this.skip === 0);
  }
}
