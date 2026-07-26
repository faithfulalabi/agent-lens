import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** True when git would ignore `path` (relative to the repo root). */
function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * AC6, asserted the way the AC words it. `.gitignore`'s `fixtures/raw/` had an
 * interior slash, which makes a gitignore pattern ROOT-anchored — so the real
 * Task 1.5 capture path (`experiments/tracer-bullet/scratch-project/fixtures/
 * raw/<exp>`, produced by capture.mjs resolving against process.cwd()) was NOT
 * ignored, and un-scrubbed raw capture sat un-ignored in a live working tree.
 */
describe('fixtures/raw is git-ignored everywhere (AC6)', () => {
  it.each([
    'fixtures/raw/x.jsonl',
    'experiments/tracer-bullet/fixtures/raw/x.jsonl',
    'experiments/tracer-bullet/scratch-project/fixtures/raw/x.jsonl',
    'experiments/tracer-bullet/fixtures/raw/multi-turn/transcripts/parent.jsonl',
    'experiments/tracer-bullet/fixtures/raw/large-output/tool-results/bz1je72dk.txt',
  ])('ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    'fixtures/scrubbed/multi-turn/envelopes.jsonl',
    'experiments/tracer-bullet/fixtures/scrubbed/multi-turn/envelopes.jsonl',
  ])('does NOT ignore %s', (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  // The scratch data dir holds the same un-scrubbed capture in SQLite form, so
  // it gets the same de-anchoring treatment.
  it.each([
    'experiments/tracer-bullet/.capture-scratch/agent-lens.db',
    'experiments/tracer-bullet/.capture-scratch/multi-turn/agent-lens.db',
    'experiments/tracer-bullet/scratch-project/.capture-scratch/agent-lens.db',
  ])('ignores the scratch data dir at %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });
});
