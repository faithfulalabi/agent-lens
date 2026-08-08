// AC2/AC3/AC4 as a property: under any sequence of appends, truncations,
// rewrites and crashes, the archive stays a byte-exact prefix of some state the
// source has been in, never shrinks, never gains a hole, and never writes a byte
// twice. Of *some historical* state, not the current one: divergence keeps the
// old bytes.

import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { appendFileSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveOnce } from '../mirror.js';
import { cleanup, makeSandbox, SLUG, writeSource, type Sandbox } from './fixtures.js';

/** Fixed seed: a failing counterexample must be reproducible on any machine. */
const SEED = 20260807;

const NUM_RUNS = 40;

const REL = `${SLUG}/sess-prop.jsonl`;

const sandboxes: Sandbox[] = [];

afterAll(() => {
  while (sandboxes.length) cleanup(sandboxes.pop()!);
});

type Mutation =
  | { kind: 'append'; count: number }
  | { kind: 'appendPartial' }
  | { kind: 'truncate'; keep: number }
  | { kind: 'rewriteHead' }
  | { kind: 'rewritePastHead'; at: number }
  | { kind: 'crashArchive'; keep: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant('append' as const), count: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant('appendPartial' as const) }),
  fc.record({ kind: fc.constant('truncate' as const), keep: fc.integer({ min: 0, max: 400 }) }),
  fc.record({ kind: fc.constant('rewriteHead' as const) }),
  fc.record({
    kind: fc.constant('rewritePastHead' as const),
    at: fc.integer({ min: 0, max: 600 }),
  }),
  fc.record({ kind: fc.constant('crashArchive' as const), keep: fc.integer({ min: 0, max: 400 }) }),
);

/**
 * A pass is an optional suffix of each mutation, not a seventh op: drawn from one
 * `oneof`, deleting divergence detection still left the property green.
 */
const stepArb = fc.record({ mutation: mutationArb, passAfter: fc.boolean() });

describe('archive convergence under an arbitrary op script (Test 22)', () => {
  it('is always a prefix of some historical source state, hole-free and write-once', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 24 }), (steps) => {
        const s = makeSandbox();
        sandboxes.push(s);
        const source = join(s.sourceRoot, REL);
        const archived = join(s.archiveRoot, REL);

        let lineNo = 0;
        // Every state the source has ever been in.
        const history: Buffer[] = [];
        let archiveSize = 0;
        let totalCopied = 0;

        const remember = () => history.push(readFileSync(source));

        writeSource(s, REL, '');
        remember();

        const runPass = () => {
          // Invariant W throws inside the copy loop, so completing is the assertion.
          const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
          expect(result.errors).toEqual([]);
          const file = result.files.find((f) => f.source_path === source);
          totalCopied += file?.bytes_copied ?? 0;

          let bytes: Buffer;
          try {
            bytes = readFileSync(archived);
          } catch {
            bytes = Buffer.alloc(0);
          }

          // Never shrinks.
          expect(bytes.length).toBeGreaterThanOrEqual(archiveSize);
          archiveSize = bytes.length;

          // No byte written twice.
          expect(bytes.length).toBe(totalCopied);

          // A byte-exact prefix of some state the source has been in.
          const isPrefixOfSome = history.some(
            (state) =>
              state.length >= bytes.length && state.subarray(0, bytes.length).equals(bytes),
          );
          expect(isPrefixOfSome).toBe(true);

          // No NUL run the source never had — the sparse-hole signature.
          if (bytes.includes(Buffer.alloc(16, 0))) {
            expect(history.some((state) => state.includes(Buffer.alloc(16, 0)))).toBe(true);
          }
        };

        for (const { mutation: op, passAfter } of steps) {
          switch (op.kind) {
            case 'append': {
              let chunk = '';
              for (let i = 0; i < op.count; i++)
                chunk += `{"n":${lineNo++},"p":"${'z'.repeat(30)}"}\n`;
              appendFileSync(source, chunk);
              remember();
              break;
            }
            case 'appendPartial': {
              appendFileSync(source, `{"n":${lineNo++},"partial":`);
              remember();
              break;
            }
            case 'truncate': {
              const size = readFileSync(source).length;
              truncateSync(source, Math.min(op.keep, size));
              remember();
              break;
            }
            case 'rewriteHead': {
              const body = readFileSync(source);
              if (body.length > 0) {
                const rewritten = Buffer.from(body);
                rewritten.fill(0x51, 0, Math.min(64, rewritten.length));
                writeFileSync(source, rewritten);
                remember();
              }
              break;
            }
            case 'rewritePastHead': {
              const body = readFileSync(source);
              if (op.at < body.length) {
                const rewritten = Buffer.from(body);
                rewritten.fill(0x52, op.at, Math.min(op.at + 32, rewritten.length));
                writeFileSync(source, rewritten);
                remember();
              }
              break;
            }
            case 'crashArchive': {
              // A crash IS a shorter prefix under Invariant W.
              try {
                const size = readFileSync(archived).length;
                truncateSync(archived, Math.min(op.keep, size));
                archiveSize = Math.min(op.keep, size);
                totalCopied = archiveSize;
              } catch {
                // Nothing archived yet.
              }
              break;
            }
          }
          if (passAfter) runPass();
        }
        runPass();
        return true;
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, 120000);
});
