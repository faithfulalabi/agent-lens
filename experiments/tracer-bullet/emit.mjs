// Q3 bait — emit EXACTLY N bytes of deterministic, marker-rich text to stdout.
//
// Drives the Q3 sweep: Claude Code runs this via its Bash tool at a range of
// sizes, and we compare what each capture surface kept against what was emitted.
// `node emit.mjs 1MB` writes exactly 1,048,576 bytes. The stream is seeded with
// byte-offset markers ("<<@000000512>>") every 512 bytes; the last surviving
// marker locates the cut. Output is pure ASCII → 1 char == 1 byte, so length
// math is exact.
//
// WHAT ACTUALLY HAPPENS (re-verified 2026-08-01, Claude Code 2.1.212). Claude
// Code does NOT simply truncate and discard. Above the cap it SPILLS the whole
// output to a sidecar file, and the three surfaces diverge:
//
//   * `toolUseResult.stdout` (transcript) and the hook payload — a raw prefix of
//     the first 30,000 BYTES. No marker, no flag, no pointer: silent. The
//     `<<@NNNNNNNNN>>` markers DO reveal the cut here (last marker @000029696).
//   * the model-facing `tool_result` content block — the output is REPLACED by a
//     `<persisted-output>` block: a rounded size label, the absolute path of the
//     sidecar, and a head-only first-2KB preview. Markers reveal nothing here;
//     the preview always ends near byte 2048 whatever the payload size.
//   * `<session-dir>/tool-results/<id>.txt` — the COMPLETE output, byte-exact.
//
// So the payload is never lost, and "find the truncation offset from the last
// marker" only describes the transcript/hook surface. The threshold is exactly
// 30,000 bytes: <=30,000 is inlined whole and writes NO sidecar; >=30,001 spills.
// Useful probe sizes are therefore 30000 and 30001, not just the round bands.
//
// LIMITATION: this emitter is ASCII-only, so it cannot exercise the multibyte
// boundary. The cap counts bytes, so a payload whose character boundaries
// straddle byte 30,000 is cut MID-SEQUENCE and the partial bytes land as U+FFFD
// — making the stored prefix 30,001 bytes, not 30,000. Any "== 30000" detector
// is wrong for non-ASCII output. See research/tracer-bullet-findings.md Q3.
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
