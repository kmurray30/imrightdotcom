/**
 * A live panel pinned to the bottom of the terminal, redrawn in place, with
 * event lines scrolling above it (used by fetch-snapshot-bundle.js). Plain
 * ANSI, no dependencies. Without a TTY nothing is drawn: events are printed
 * as plain lines and the caller logs its own status.
 */
const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Visible length (escape codes don't count). */
export const visibleLength = (text) => text.replace(ANSI, '').length;

/** Cuts `text` to `width` visible characters (keeping escape codes), then pads it with spaces. */
export function fit(text, width) {
  let out = '';
  let shown = 0;
  let lastVisibleAt = -1;
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\x1b') {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (shown >= width) {
      if (lastVisibleAt >= 0) out = `${out.slice(0, lastVisibleAt)}…${out.slice(lastVisibleAt + 1)}`;
      break;
    }
    lastVisibleAt = out.length;
    out += text[i++];
    shown++;
  }
  if (useColor && out.includes('\x1b[')) out += '\x1b[0m';
  return out + ' '.repeat(Math.max(0, width - shown));
}

/** A bar `width` wide made of colored segments: [{ fraction, paint, char }], the rest drawn as an empty track. */
export function bar(width, segments) {
  let out = '';
  let used = 0;
  for (const { fraction, paint: paintSegment = (s) => s, char = '█' } of segments) {
    const cells = Math.min(width - used, Math.round(Math.max(0, fraction) * width));
    if (cells <= 0) continue;
    out += paintSegment(char.repeat(cells));
    used += cells;
  }
  return out + color.gray('░'.repeat(width - used));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const formatCount = (n) => Math.round(n).toLocaleString('en-US');

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

const clock = () => new Date().toTimeString().slice(0, 8);

/**
 * `render(innerWidth)` returns { title, right, lines } for the panel. `event(text)`
 * prints a timestamped line above the panel (it stays in the scrollback).
 */
export function createPanel(render) {
  let height = 0; // rows the last draw used
  let hidden = false;

  const width = () => Math.max(40, Math.min(100, (process.stdout.columns || 100) - 1));

  function frame() {
    const outer = width();
    const inner = outer - 4;
    const { title, right, lines } = render(inner);
    const head = ` ${color.bold(title)} `;
    const tail = right ? ` ${right} ` : '';
    const fill = Math.max(1, outer - 3 - visibleLength(head) - visibleLength(tail));
    const rows = [color.gray('╭─') + head + color.gray('─'.repeat(fill)) + tail + color.gray('╮')];
    for (const line of lines) rows.push(`${color.gray('│')} ${fit(line, inner)} ${color.gray('│')}`);
    rows.push(color.gray(`╰${'─'.repeat(outer - 2)}╯`));
    return rows;
  }

  function clear() {
    if (height > 0) process.stdout.write(`\x1b[${height}A\r\x1b[0J`);
    height = 0;
  }

  function draw() {
    if (!isTTY) return;
    if (!hidden) {
      process.stdout.write('\x1b[?25l');
      hidden = true;
    }
    const rows = frame();
    clear();
    process.stdout.write(rows.join('\n') + '\n');
    height = rows.length;
  }

  function event(text) {
    if (!isTTY) {
      process.stdout.write(`${clock()}  ${text.replace(ANSI, '')}\n`);
      return;
    }
    clear();
    process.stdout.write(`${color.gray(clock())}  ${text}\n`);
    draw();
  }

  /** Last draw, cursor back on. */
  function close() {
    if (!isTTY) return;
    draw();
    process.stdout.write('\x1b[?25h');
    hidden = false;
  }

  const restoreCursor = () => hidden && process.stdout.write('\x1b[?25h');
  process.on('exit', restoreCursor);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      restoreCursor();
      process.exit(130);
    });
  }
  if (isTTY) process.stdout.on('resize', () => {
    // The old frame may have wrapped at the new width; start a fresh one below it.
    height = 0;
    process.stdout.write('\n');
    draw();
  });

  return { draw, event, close, isTTY };
}
