/**
 * Shared helpers for the one-row, redraw-in-place progress tables printed by
 * build-index-from-wikimedia.js and create-ann-index.js.
 */

/** "3d14h" / "23h5m" / "5m32s" / "45s" — the two largest non-zero units only, not every unit down to seconds. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const totalSeconds = Math.floor(seconds);
  const units = [
    { label: 'd', value: Math.floor(totalSeconds / 86400) },
    { label: 'h', value: Math.floor((totalSeconds % 86400) / 3600) },
    { label: 'm', value: Math.floor((totalSeconds % 3600) / 60) },
    { label: 's', value: totalSeconds % 60 },
  ];
  const firstNonZero = units.findIndex((u) => u.value > 0);
  if (firstNonZero === -1) return '0s';
  return units
    .slice(firstNonZero, firstNonZero + 2)
    .map((u) => `${u.value}${u.label}`)
    .join('');
}

/**
 * Truncates to the terminal's actual width and clears any leftover
 * characters from a previous, longer render. Without this, a line that
 * exceeds the terminal width wraps onto a second row, and "\r" then only
 * returns to the start of THAT wrapped row rather than the true beginning
 * of the logical line — which is what turns a one-line progress display
 * into what looks like a new line being printed on every tick, each one
 * cut off mid-word. process.stdout.columns is undefined when stdout isn't
 * a TTY (e.g. piped to a file), in which case there's no wrapping concern.
 */
export function fitToTerminal(line) {
  const width = process.stdout.columns;
  const fitted = width && line.length > width - 1 ? line.slice(0, width - 1) : line;
  return `\r${fitted}\x1b[K`; // \x1b[K: clear from cursor to end of line
}

export function padLeft(text, width) {
  return text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text;
}
export function padRight(text, width) {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}
export function center(text, width) {
  if (text.length >= width) return text.slice(0, width);
  const pad = width - text.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

export function tableBorder(widths) {
  return '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
}

/** aligns: one of 'left'/'right'/'center' per column, defaulting to 'right' (numeric data reads naturally right-aligned in a table). */
export function tableRow(cells, widths, aligns = []) {
  return (
    '|' +
    cells
      .map((cell, i) => {
        const width = widths[i];
        const align = aligns[i] ?? 'right';
        const padded = align === 'center' ? center(cell, width) : align === 'left' ? padRight(cell, width) : padLeft(cell, width);
        return ` ${padded} `;
      })
      .join('|') +
    '|'
  );
}
