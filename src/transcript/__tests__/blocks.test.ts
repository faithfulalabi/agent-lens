// Task 2.3 AC1-AC5 and AC11 for `../blocks.js`. Two halves, deliberately:
// hand-authored fixtures pin the exact shapes, and an opt-in sweep over
// `~/.agent-lens/archive` pins the PROPERTIES against real data.
//
// No absolute count is asserted against the archive anywhere in this file. A
// launchd cron appends to it every 15 minutes, so a pinned count is stale within
// a day — the doctrine and the gate both come from `./archive-invariants.test.ts`.
// Measured figures appear as dated evidence in prose and as printed diagnostics.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { obj } from '../accessors.js';
import {
  classifyBlock,
  classifyContent,
  normalizeContent,
  THINKING_ELIDED_MARKER,
  type Block,
  type BlockKind,
} from '../blocks.js';
import { ARCHIVE_ROOT, archiveJsonlFiles, fixtureBytes, offsetLines, runIt } from './fixtures.js';

/** Lower bounds, well under 2026-08-13's measurement of 262 files / 43,108 lines. */
const MIN_FILES = 100;
const MIN_LINES = 20000;

/** `src/transcript/` — the directory this file's `__tests__/` sits in. */
const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** A run of base64 long enough that no placeholder or identifier can produce it. */
const BASE64_RUN = /[A-Za-z0-9+/]{64,}/;

/**
 * `message.content` of one raw line, read WITHOUT the module under test. The
 * 2.1 accessors are a different module, so leaning on them here is reuse rather
 * than an oracle that checks the code against itself.
 */
function rawContent(json: unknown): unknown {
  return obj(obj(json, undefined)?.message, undefined)?.content;
}

/**
 * How many rows this line's content must produce, derived from the raw JSON
 * rather than from `normalizeContent` — an oracle that called the code under
 * test would be an identity, not a check.
 */
function expectedRows(content: unknown): number {
  if (Array.isArray(content)) return content.length;
  return typeof content === 'string' ? 1 : 0;
}

function fixtureJson(name: string): unknown[] {
  return offsetLines(fixtureBytes(name).toString('utf8')).map((entry) => JSON.parse(entry.text));
}

function kinds(blocks: readonly Block[]): BlockKind[] {
  return blocks.map((block) => block.kind);
}

/** A base64 payload of exactly `chars` characters. Only its length is ever read. */
function base64(chars: number): string {
  return 'A'.repeat(chars);
}

function imageBlock(chars: number, mediaType = 'image/jpeg'): unknown {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64(chars) } };
}

/** Does `file` declare a `try` of its own? The same AST idiom as `module-shape.test.ts`. */
function declaresTry(file: string): boolean {
  const text = readFileSync(join(MODULE_DIR, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('AC1 — the block inventory is total', () => {
  const lines = fixtureJson('blocks-top-level.jsonl');

  it('classifies every top-level kind the fixture carries', () => {
    expect(kinds(classifyContent(rawContent(lines[0])))).toEqual([
      'text',
      'thinking_elided',
      'thinking',
      'tool_use',
    ]);
    expect(kinds(classifyContent(rawContent(lines[1])))).toEqual(['tool_result']);
    expect(kinds(classifyContent(rawContent(lines[2])))).toEqual(['image']);
    expect(kinds(classifyContent(rawContent(lines[4])))).toEqual(['text']);
  });

  it('reads tool_use identity and input through the accessors', () => {
    const [block] = classifyContent(rawContent(lines[0])).slice(-1);
    expect(block).toEqual({
      kind: 'tool_use',
      id: 'toolu_01',
      name: 'Read',
      input: { file_path: '/repo/a.ts' },
    });
  });

  it('turns everything unnameable into unknown_block carrying the raw type verbatim', () => {
    // The fourth line is 100% unrecognisable: a type nobody has measured, a
    // `tool_reference` in the one position it may not appear, a bare number and
    // an object with no type at all.
    expect(classifyContent(rawContent(lines[3]))).toEqual([
      { kind: 'unknown_block', raw_type: 'holographic_preview' },
      { kind: 'unknown_block', raw_type: 'tool_reference' },
      { kind: 'unknown_block', raw_type: '' },
      { kind: 'unknown_block', raw_type: '' },
    ]);
  });

  it('yields exactly one row per block on every fixture line — none dropped, none invented', () => {
    for (const name of ['blocks-top-level.jsonl', 'blocks-nested-tool-result.jsonl']) {
      for (const [index, json] of fixtureJson(name).entries()) {
        const content = rawContent(json);
        expect(classifyContent(content), `${name}:${index}`).toHaveLength(expectedRows(content));
      }
    }
  });

  it('carries a tool_result’s nested blocks as children, never as sibling rows', () => {
    const nested = fixtureJson('blocks-nested-tool-result.jsonl');
    const [result] = classifyContent(rawContent(nested[0]));
    expect(result?.kind).toBe('tool_result');
    if (result?.kind !== 'tool_result') throw new Error('unreachable');
    expect(result.tool_call_id).toBe('toolu_10');
    expect(result.is_error).toBe(false);
    expect(kinds(result.children)).toEqual(['text', 'image', 'tool_reference']);
    expect(result.children.at(-1)).toEqual({ kind: 'tool_reference', name: 'SendMessage' });
  });

  it('gives a bare-string tool_result content exactly one nested text child', () => {
    const nested = fixtureJson('blocks-nested-tool-result.jsonl');
    const [result] = classifyContent(rawContent(nested[1]));
    if (result?.kind !== 'tool_result') throw new Error('unreachable');
    expect(result.children).toEqual([{ kind: 'text', text: 'plain stdout, no array in sight' }]);
  });

  it('reads is_error as a strict true, and stops recursing after one level', () => {
    const nested = fixtureJson('blocks-nested-tool-result.jsonl');
    const [deeper] = classifyContent(rawContent(nested[2]));
    if (deeper?.kind !== 'tool_result') throw new Error('unreachable');
    // Nothing in the corpus nests two levels (0 occurrences). A block that tried
    // would surface as unknown_block rather than being silently emptied, which
    // is what bounds the recursion without a depth counter.
    expect(deeper.children).toEqual([
      { kind: 'unknown_block', raw_type: 'tool_result' },
      { kind: 'unknown_block', raw_type: '' },
    ]);

    const [failed] = classifyContent(rawContent(nested[3]));
    if (failed?.kind !== 'tool_result') throw new Error('unreachable');
    expect(failed.is_error).toBe(true);
  });
});

describe('AC2 — tool_reference is a placement rule, not a type', () => {
  it('is the SAME object, and the position alone decides what it becomes', () => {
    const block = { type: 'tool_reference', tool_name: 'SendMessage' };
    expect(classifyBlock(block, 'in_tool_result')).toEqual({
      kind: 'tool_reference',
      name: 'SendMessage',
    });
    expect(classifyBlock(block, 'top')).toEqual({
      kind: 'unknown_block',
      raw_type: 'tool_reference',
    });
  });
});

describe('AC3 — a bare string classifies as a single-element text array', () => {
  it('is identical for any string fast-check can build', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(classifyContent(text)).toEqual(classifyContent([{ type: 'text', text }]));
        expect(classifyContent(text)).toEqual([{ kind: 'text', text }]);
      }),
      { seed: 20260813, numRuns: 500 },
    );
  });

  it('yields no blocks for content that is neither a string nor an array', () => {
    // Defensive: `message.content` is only ever absent, a string or an array
    // across 43,108 measured lines, so this branch has no corpus witness.
    for (const content of [undefined, null, 7, true, { type: 'text', text: 'x' }]) {
      expect(normalizeContent(content), String(content)).toEqual([]);
      expect(classifyContent(content), String(content)).toEqual([]);
    }
  });
});

describe('AC4 — an image emits a placeholder and no base64 ever escapes', () => {
  it('renders the literal form, one decimal, decoded bytes at 3/4 of the base64', () => {
    // The worked example: the largest image in the archive, 636,160 base64
    // characters. The raw length would read 636.2 KB — 33% too big.
    expect(classifyBlock(imageBlock(636160), 'top')).toEqual({
      kind: 'image',
      media_type: 'image/jpeg',
      byte_length: 477120,
      placeholder: '[image image/jpeg, 477.1 KB]',
    });
  });

  it('switches to MB at 1,000 KB and not before', () => {
    // No corpus image reaches MB (all 40 measure 65.0 KB to 477.1 KB), so both
    // sides of the threshold are hand-authored.
    const below = classifyBlock(imageBlock(1333332, 'image/png'), 'top');
    const above = classifyBlock(imageBlock(1333336, 'image/png'), 'top');
    if (below.kind !== 'image' || above.kind !== 'image') throw new Error('unreachable');
    expect(below.byte_length).toBe(999999);
    expect(below.placeholder).toBe('[image image/png, 1000.0 KB]');
    expect(above.byte_length).toBe(1000002);
    expect(above.placeholder).toBe('[image image/png, 1.0 MB]');
  });

  it('drops the payload at the classification boundary, top-level and nested alike', () => {
    const payload = base64(4096);
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: payload },
    };
    const serialized = JSON.stringify(
      classifyContent([image, { type: 'tool_result', tool_use_id: 't', content: [image] }]),
    );

    // Non-vacuity: the input really does carry a long base64 run, so the zero
    // below is the classifier dropping it rather than the fixture lacking one.
    expect(BASE64_RUN.test(JSON.stringify(image))).toBe(true);
    expect(serialized).not.toContain(payload);
    expect(BASE64_RUN.test(serialized)).toBe(false);
  });

  it('leaks nothing from the committed fixtures either, signatures included', () => {
    for (const name of ['blocks-top-level.jsonl', 'blocks-nested-tool-result.jsonl']) {
      const text = fixtureBytes(name).toString('utf8');
      expect(BASE64_RUN.test(text), `${name} carries no long payload to leak`).toBe(true);
      const rows = fixtureJson(name).map((json) => classifyContent(rawContent(json)));
      expect(BASE64_RUN.test(JSON.stringify(rows)), name).toBe(false);
    }
  });
});

describe('AC5 — an empty thinking block collapses to exactly one marker', () => {
  it('emits one marker per empty block, never zero and never a blank row', () => {
    const empty = { type: 'thinking', thinking: '', signature: 'x'.repeat(1024) };
    expect(classifyContent([empty, empty, empty])).toEqual([
      { kind: 'thinking_elided', text: THINKING_ELIDED_MARKER },
      { kind: 'thinking_elided', text: THINKING_ELIDED_MARKER },
      { kind: 'thinking_elided', text: THINKING_ELIDED_MARKER },
    ]);
    expect(THINKING_ELIDED_MARKER).toBe('reasoning not recorded (signature only)');
  });

  it('renders a non-empty thinking block as its own text', () => {
    // 100% of the corpus is empty, so this branch has no witness there. It is
    // the branch that matters the day the harness starts recording reasoning.
    expect(classifyContent([{ type: 'thinking', thinking: 'weighing two options' }])).toEqual([
      { kind: 'thinking', text: 'weighing two options' },
    ]);
  });
});

describe('AC11 — classifyContent is total, and the module owns no try', () => {
  it('never throws on anything fast-check can build', () => {
    fc.assert(
      fc.property(
        fc.anything({ maxDepth: 4, withBigInt: true, withMap: true, withSet: true }),
        (value) => {
          expect(() => classifyContent(value)).not.toThrow();
          expect(() => classifyBlock(value, 'top')).not.toThrow();
          expect(() => classifyBlock(value, 'in_tool_result')).not.toThrow();
        },
      ),
      { seed: 20260813, numRuns: 500 },
    );
  });

  it('never throws on a content array of hostile blocks', () => {
    fc.assert(
      fc.property(fc.array(fc.anything({ maxDepth: 3 }), { maxLength: 8 }), (blocks) => {
        expect(() => classifyContent(blocks)).not.toThrow();
        expect(classifyContent(blocks)).toHaveLength(blocks.length);
      }),
      { seed: 20260813, numRuns: 500 },
    );
  });

  it('neither blocks.ts nor human.ts declares a try — totality is 2.1’s job', () => {
    // Non-vacuous by construction: `accessors.ts` carries the one documented
    // `try` in the module, so a walker that saw nothing would red on that row.
    expect(declaresTry('blocks.ts')).toBe(false);
    expect(declaresTry('human.ts')).toBe(false);
    expect(declaresTry('accessors.ts')).toBe(true);
  });
});

interface Sweep {
  files: number;
  lines: number;
  top: Map<string, number>;
  nested: Map<string, number>;
  bareString: { total: number; onUser: number; oneTextBlock: number };
  bareToolResult: { total: number; oneTextChild: number };
  thinking: { total: number; empty: number; signed: number };
  images: number;
  base64Leaks: number;
  rowMismatches: string[];
}

let swept: Sweep | undefined;

/** One walk of the archive, shared by every gated test below. Counters only. */
function sweepArchive(): Sweep {
  if (swept !== undefined) return swept;

  const sweep: Sweep = {
    files: 0,
    lines: 0,
    top: new Map(),
    nested: new Map(),
    bareString: { total: 0, onUser: 0, oneTextBlock: 0 },
    bareToolResult: { total: 0, oneTextChild: 0 },
    thinking: { total: 0, empty: 0, signed: 0 },
    images: 0,
    base64Leaks: 0,
    rowMismatches: [],
  };
  const bump = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const file of archiveJsonlFiles(ARCHIVE_ROOT)) {
    sweep.files += 1;
    for (const entry of offsetLines(readFileSync(file).toString('utf8'))) {
      sweep.lines += 1;
      let json: unknown;
      try {
        json = JSON.parse(entry.text);
      } catch {
        continue;
      }

      const content = rawContent(json);
      const rows = classifyContent(content);
      if (rows.length !== expectedRows(content)) sweep.rowMismatches.push(file);

      if (typeof content === 'string') {
        sweep.bareString.total += 1;
        if (obj(json, undefined)?.type === 'user') sweep.bareString.onUser += 1;
        if (rows.length === 1 && rows[0]?.kind === 'text') sweep.bareString.oneTextBlock += 1;
      }

      const rawBlocks = Array.isArray(content) ? content : [];
      for (const [index, row] of rows.entries()) {
        bump(sweep.top, row.kind);
        const raw = obj(rawBlocks[index], undefined);

        if (raw?.type === 'thinking') {
          sweep.thinking.total += 1;
          if (raw.thinking === '' || raw.thinking === undefined) sweep.thinking.empty += 1;
          if (typeof raw.signature === 'string' && raw.signature !== '') sweep.thinking.signed += 1;
        }

        if (row.kind === 'tool_result') {
          for (const child of row.children) bump(sweep.nested, child.kind);
          if (typeof raw?.content === 'string') {
            sweep.bareToolResult.total += 1;
            if (row.children.length === 1 && row.children[0]?.kind === 'text') {
              sweep.bareToolResult.oneTextChild += 1;
            }
          }
        }

        // Top-level and nested images alike. Scoped to the image block itself:
        // a `tool_use` input is passed through verbatim and may legitimately
        // hold a long token, which is not a leak of a dropped payload.
        const images = row.kind === 'tool_result' ? row.children : [row];
        for (const image of images) {
          if (image.kind !== 'image') continue;
          sweep.images += 1;
          if (BASE64_RUN.test(JSON.stringify(image))) sweep.base64Leaks += 1;
        }
      }
    }
  }

  swept = sweep;
  return sweep;
}

function nonVacuous(sweep: Sweep): void {
  expect(sweep.files).toBeGreaterThanOrEqual(MIN_FILES);
  expect(sweep.lines).toBeGreaterThanOrEqual(MIN_LINES);
}

describe('the archive classifies into the expected kinds (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'covers the named expected subset of kinds, top-level and nested',
    () => {
      const sweep = sweepArchive();
      nonVacuous(sweep);

      // Printed, never asserted on: `thinking`, top-level `tool_reference` and
      // `unknown_block` all measure 0 today, so asserting the full declared list
      // reds on day one and asserting their absence reds the day the harness
      // emits one. Same reasoning as `archive-invariants.test.ts:100-105`.
      console.log('top-level blocks', Object.fromEntries(sweep.top));
      console.log('nested blocks', Object.fromEntries(sweep.nested));

      // Blocks in == rows out, on every line of every file.
      expect(sweep.rowMismatches).toEqual([]);

      for (const kind of ['text', 'thinking_elided', 'tool_use', 'tool_result', 'image']) {
        expect(sweep.top.has(kind), `no top-level ${kind} in the archive`).toBe(true);
      }
      for (const kind of ['text', 'image', 'tool_reference']) {
        expect(sweep.nested.has(kind), `no nested ${kind} in the archive`).toBe(true);
      }
    },
    600000,
  );

  runIt(
    'gives every bare-string tool_result content exactly one nested text child',
    () => {
      const sweep = sweepArchive();
      nonVacuous(sweep);
      console.log('bare-string tool_result contents', sweep.bareToolResult.total);

      expect(sweep.bareToolResult.total).toBeGreaterThan(0);
      expect(sweep.bareToolResult.oneTextChild).toBe(sweep.bareToolResult.total);
    },
    600000,
  );

  runIt(
    'AC3 — every bare-string message.content is on a user line and yields one text block',
    () => {
      const sweep = sweepArchive();
      nonVacuous(sweep);
      console.log('bare-string message.content', sweep.bareString);

      expect(sweep.bareString.total).toBeGreaterThan(0);
      expect(sweep.bareString.onUser).toBe(sweep.bareString.total);
      expect(sweep.bareString.oneTextBlock).toBe(sweep.bareString.total);
    },
    600000,
  );

  runIt(
    'AC5 — every thinking block in the archive is empty AND signed',
    () => {
      const sweep = sweepArchive();
      nonVacuous(sweep);
      console.log('thinking blocks', sweep.thinking);

      expect(sweep.thinking.total).toBeGreaterThan(0);
      expect(sweep.thinking.empty).toBe(sweep.thinking.total);
      expect(sweep.thinking.signed).toBe(sweep.thinking.total);
      // The whole point of the marker: 100% empty means 100% blank rows without it.
      expect(sweep.top.get('thinking_elided')).toBe(sweep.thinking.total);
    },
    600000,
  );

  runIt(
    'AC4 — no classified image carries a base64 run out of the archive',
    () => {
      const sweep = sweepArchive();
      nonVacuous(sweep);
      console.log('images classified', sweep.images, 'leaks', sweep.base64Leaks);

      expect(sweep.images).toBeGreaterThan(0);
      expect(sweep.base64Leaks).toBe(0);
    },
    600000,
  );
});
