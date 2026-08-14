// Fixture loading for the Task 2.2 suites. Same role as
// `src/archive/__tests__/fixtures.ts`: one place that reads bytes, so the tests
// below it assert behaviour instead of re-deriving file plumbing four times.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLine, type LineContext, type ParsedLine } from '../line.js';
import { DriftCounter } from '../drift.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** One JSONL line with the byte offset of its first byte. */
export interface OffsetLine {
  text: string;
  byteOffset: number;
}

export function fixtureBytes(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

/**
 * Split a JSONL file into lines carrying BYTE offsets.
 *
 * `Buffer.byteLength`, never a string index: one 4-byte emoji in a prompt
 * desynchronises every offset after it, and the corpus is full of them. This
 * mirrors what the corpus walker (Task 4.1) must do, so the offsets the
 * classifier is handed here are the offsets it will be handed in production.
 */
export function offsetLines(text: string): OffsetLine[] {
  const lines: OffsetLine[] = [];
  let byteOffset = 0;
  for (const line of text.split('\n')) {
    if (line !== '') lines.push({ text: line, byteOffset });
    byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the '\n'
  }
  return lines;
}

/** Every line of a fixture, classified, sharing one `DriftCounter`. */
export function classifyFixture(name: string): {
  lines: ParsedLine[];
  drift: DriftCounter;
  offsets: OffsetLine[];
} {
  const drift = new DriftCounter();
  const offsets = offsetLines(fixtureBytes(name).toString('utf8'));
  const lines = offsets.map((entry) =>
    classifyLine(JSON.parse(entry.text), { byteOffset: entry.byteOffset, drift }),
  );
  return { lines, drift, offsets };
}

/**
 * Every `.jsonl` file under `root`, recursively. The real-corpus enumerator for
 * the opt-in sweeps, shared so one walker serves every suite rather than each
 * keeping a private copy that skips a directory the others do not.
 */
export function archiveJsonlFiles(root: string, found: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) archiveJsonlFiles(path, found);
    else if (entry.isFile() && path.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

/** A throwaway context for classifying a single hand-built object. */
export function ctx(byteOffset = 0): LineContext & { drift: DriftCounter } {
  return { byteOffset, drift: new DriftCounter() };
}
