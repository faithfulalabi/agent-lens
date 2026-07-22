// Q3 bait — emit EXACTLY N bytes of deterministic, marker-rich text to stdout.
//
// The hook `tool_output` truncation threshold (Q3) is probed by driving Claude
// Code to run tools whose output spans size bands {1KB, 100KB, 1MB, 10MB}. This
// script is that tool: `node emit.mjs 1MB` writes exactly 1,048,576 bytes. The
// stream is seeded with byte-offset markers ("<<@000000512>>") every 512 bytes
// so the captured (possibly truncated) `tool_output` reveals the exact cutoff
// offset. Output is pure ASCII → 1 char == 1 byte, so length math is exact.
//
// Run: node experiments/tracer-bullet/emit.mjs <size>
//   <size> = an integer byte count, or a band label: 1KB | 100KB | 1MB | 10MB.
// Importable: `import { buildPayload, parseSize } from "./emit.mjs"`.

import process from 'node:process';

/** Named size bands for the Q3 sweep, in bytes. */
export const SIZE_BANDS = {
  '1KB': 1024,
  '100KB': 100 * 1024,
  '1MB': 1024 * 1024,
  '10MB': 10 * 1024 * 1024,
};

/** Emit a marker every this many bytes so truncation offset is recoverable. */
const MARKER_STRIDE = 512;

/**
 * Resolve a size argument to an exact byte count. Accepts a band label
 * (case-insensitive) or a positive integer string. Throws on anything else.
 *
 * @param {string} arg
 * @returns {number}
 */
export function parseSize(arg) {
  if (arg === undefined || arg === '') {
    throw new Error('size required: a byte count or one of 1KB|100KB|1MB|10MB');
  }
  const band = SIZE_BANDS[arg.toUpperCase()];
  if (band !== undefined) return band;
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    if (n > 0) return n;
  }
  throw new Error(`invalid size "${arg}": use a byte count or 1KB|100KB|1MB|10MB`);
}

/**
 * Build a payload of EXACTLY `bytes` ASCII characters. A marker of the form
 * `<<@000000000>>` (zero-padded absolute byte offset) is written at every
 * MARKER_STRIDE boundary; the gaps are filled with a repeating filler. The
 * result is truncated/padded to land on the exact requested length.
 *
 * @param {number} bytes - target length; must be a positive integer.
 * @returns {string} exactly `bytes` characters (== bytes, ASCII).
 */
export function buildPayload(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`bytes must be a positive integer, got ${bytes}`);
  }
  const out = [];
  let written = 0;
  const filler = '.';
  while (written < bytes) {
    if (written % MARKER_STRIDE === 0) {
      const marker = `<<@${String(written).padStart(9, '0')}>>`;
      out.push(marker);
      written += marker.length;
    } else {
      out.push(filler);
      written += 1;
    }
  }
  // The last marker may have overshot; slice to the exact requested length.
  return out.join('').slice(0, bytes);
}

/** CLI entry: parse the size arg, write exactly that many bytes to stdout. */
function main() {
  const bytes = parseSize(process.argv[2]);
  process.stdout.write(buildPayload(bytes));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
