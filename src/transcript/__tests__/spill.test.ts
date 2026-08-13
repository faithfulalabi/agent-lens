// AC2, AC4, AC5, AC6 and AC7 for `../spill.js`. Builders are module-local: a
// shared `__tests__/fixtures.ts` is touched by every concurrent Phase 2 branch
// and conflicts on every merge.
//
// Every behavioural test drives an INJECTED `exists` probe, so no live directory
// is touched and no assertion decays as the corpus expires. The two tiers that
// do read disk are gated — `existsSync` for the frozen fixtures (whose
// `tool-results/` is gitignored) and `AGENT_LENS_REAL_CORPUS=1` for the archive.
//
// Test 12's guard walks this module's SYNTAX TREE rather than its text, for two
// reasons spelled out at its own describe block.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  isHarnessTruncated,
  resolvePersistedOutput,
  TRUNCATION_BYTES,
  type ResolveEnv,
  type SpillState,
} from '../spill.js';

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SPILL_FILE = 'spill.ts';

/** A path the harness would have written on the machine that produced the spill. */
const DECLARED = '/home/USER/.claude/projects/-slug/sess-1/tool-results/bpm6s2ql8.txt';

/** An `exists` probe over a fixed set — the seam that makes every case hermetic. */
function envWith(present: readonly string[], extra: Partial<ResolveEnv> = {}): ResolveEnv {
  const set = new Set(present);
  return { exists: (path) => set.has(path), ...extra };
}

/** A user line carrying the structured spill pointer, as the harness sends it. */
function pointerLine(
  path: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01xyz', content: 'preview' }],
    },
    toolUseResult: { stdout: 'preview', stderr: '', persistedOutputPath: path, ...overrides },
  };
}

/**
 * The harness's spill marker, decomposed exactly as measured and byte-identical
 * to `merge.test.ts`'s helper: a header naming the size and the absolute path, a
 * preview of EXACTLY 2,000 bytes (the "2KB" label is decimal and approximate),
 * and a 24-byte footer.
 */
function markerBlock(path: string, label = '100KB'): string {
  const header = `<persisted-output>\nOutput too large (${label}). Full output saved to: ${path}\n\nPreview (first 2KB):\n`;
  return `${header}${'p'.repeat(2000)}\n...\n</persisted-output>`;
}

/** A user line whose tool result is a marker string and nothing else. */
function markerLine(text: string, arrayForm = false): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01xyz',
          content: arrayForm ? [{ type: 'text', text }] : text,
        },
      ],
    },
  };
}

describe('AC2 — the structured pointer wins and is recorded verbatim', () => {
  it('resolves to the declared path when the file is there', () => {
    const state = resolvePersistedOutput(pointerLine(DECLARED), envWith([DECLARED]));

    expect(state).toEqual({ kind: 'resolved', path: DECLARED, source: 'pointer' });
  });

  it('carries the exact declared size when the harness supplied one', () => {
    const line = pointerLine(DECLARED, { persistedOutputSize: 102400 });
    const state = resolvePersistedOutput(line, envWith([DECLARED]));

    expect(state).toMatchObject({ kind: 'resolved', declaredSize: 102400 });
  });

  it('omits a non-integer size rather than rounding or coercing it', () => {
    for (const size of ['102400', 1024.5, NaN, Infinity, null, {}]) {
      const line = pointerLine(DECLARED, { persistedOutputSize: size });
      const state = resolvePersistedOutput(line, envWith([DECLARED]));
      expect(state, JSON.stringify(size)).toMatchObject({ kind: 'resolved' });
      expect(
        (state as { declaredSize?: number }).declaredSize,
        JSON.stringify(size),
      ).toBeUndefined();
    }
  });

  it('an absent target is missing:not-on-disk and KEEPS the declared path', () => {
    // The path is the only record of what was spilled. Discarding it because the
    // file is gone would leave the UI unable to name the loss.
    const state = resolvePersistedOutput(pointerLine(DECLARED), envWith([]));

    expect(state).toEqual({ kind: 'missing', reason: 'not-on-disk', declaredPath: DECLARED });
  });

  it('a line claiming no spill at all is none, which is not missing', () => {
    const plain = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'all fine' }] },
      toolUseResult: { stdout: 'all fine', stderr: '' },
    };

    expect(resolvePersistedOutput(plain, envWith([]))).toEqual({ kind: 'none' });
  });

  it('the pointer beats a marker that names a different file', () => {
    const other = '/home/USER/.claude/projects/-slug/sess-1/tool-results/OTHER.txt';
    const line = {
      ...pointerLine(DECLARED),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: markerBlock(other) }],
      },
    };

    expect(resolvePersistedOutput(line, envWith([DECLARED, other]))).toMatchObject({
      path: DECLARED,
      source: 'pointer',
    });
  });
});

describe('AC2 — the marker parses only when it is anchored at index 0', () => {
  it('resolves a marker block at index 0', () => {
    const state = resolvePersistedOutput(markerLine(markerBlock(DECLARED)), envWith([DECLARED]));

    expect(state).toEqual({ kind: 'resolved', path: DECLARED, source: 'marker' });
  });

  it('reads the marker through the nested text-block form too', () => {
    const state = resolvePersistedOutput(
      markerLine(markerBlock(DECLARED), true),
      envWith([DECLARED]),
    );

    expect(state).toMatchObject({ kind: 'resolved', path: DECLARED, source: 'marker' });
  });

  it('the identical literal mid-prose is none — startsWith, never includes', () => {
    // The regression `merge.ts` documents: the same literal occurs in assistant
    // prose and in `Stop.last_assistant_message`. A substring test would resolve
    // a spill for the model merely TALKING about truncation.
    const prose = `Note that the underlying harness writes <persisted-output> when output spills. Full output saved to: ${DECLARED}`;
    // Self-guarding: the literal really is mid-string, and the line even carries
    // a parseable path, so only the anchoring keeps this from resolving.
    expect(prose.indexOf('<persisted-output>')).toBe(40);

    const state = resolvePersistedOutput(markerLine(prose), envWith([DECLARED]));

    expect(state).toEqual({ kind: 'none' });
    expect(state).not.toHaveProperty('path');
  });
});

describe('AC4 — both measured phrasings parse, and the elided form fabricates nothing', () => {
  // Measured over the frozen archive: all 53 marker blocks use the single
  // phrasing below, and all 43 structured references carry an absolute path.
  it.each([
    ['the measured phrasing', markerBlock(DECLARED)],
    ['a different size label', markerBlock(DECLARED, '2.3MB')],
  ])('%s resolves', (_label, text) => {
    expect(resolvePersistedOutput(markerLine(text), envWith([DECLARED]))).toMatchObject({
      kind: 'resolved',
      path: DECLARED,
    });
  });

  it('the elided-path form is missing:no-path with an UNDEFINED path', () => {
    // UNREPRODUCED in the 2026-08-13 archive — every structured reference there
    // carries an absolute path, and each apparent elided instance traces to
    // agent-lens's own documentation being read back as transcript data. Built by
    // hand and retained as a hardening case: a resolver that throws or fabricates
    // on an unparseable marker is a real bug regardless of witness.
    const elided =
      '<persisted-output>\nOutput too large (100KB). Full output saved to a file.\n</persisted-output>';
    const state = resolvePersistedOutput(markerLine(elided), envWith([DECLARED]));

    expect(state).toEqual({ kind: 'missing', reason: 'no-path' });
    // Asserted explicitly: `undefined`, never a plausible-looking guess.
    expect((state as { path?: string }).path).toBeUndefined();
    expect((state as { declaredPath?: string }).declaredPath).toBeUndefined();
    expect(state).not.toHaveProperty('path');
  });

  it.each([
    ['marker alone, no path line', '<persisted-output>\n</persisted-output>'],
    ['marker with an empty tail', '<persisted-output>'],
    ['header truncated mid-word', '<persisted-output>\nOutput too large (100KB). Full output sav'],
  ])('%s is missing:no-path, never a throw', (_label, text) => {
    const state = resolvePersistedOutput(markerLine(text), envWith([]));

    expect(state).toEqual({ kind: 'missing', reason: 'no-path' });
  });
});

describe('AC5 — basename resolution assumes nothing about tool_use_id', () => {
  // Measured over the frozen archive: 43 structured references, of which 0
  // basenames start with `toolu_` and 0 equal `<tool_use_id>.txt`. A resolver
  // deriving `tool-results/<tool_use_id>.txt` succeeds ZERO times.
  const MEASURED: readonly (readonly [string, string])[] = [
    ['butub7r77.txt', 'toolu_017zADCg8hn2xWm41GigiwMK'],
    ['bgkhsu7v3.txt', 'toolu_01KAcFk7GyweXk5MCN8ziMkV'],
    ['b4y3e23yi.txt', 'toolu_015Jj6EHsWDchRXgPy2y5jiN'],
    ['br407b2c9.txt', 'toolu_013ntAjo8D4Xb8CGnEuU1W37'],
    ['bh1d2s4uu.txt', 'toolu_01WC5kw4tJASFmpBGn35ToxD'],
    ['bg6r744qz.txt', 'toolu_01KSWBuoywD1dxfaggZCsmYz'],
    ['by91z7oie.txt', 'toolu_01UsVvSdBhuJ2KM65Dcazvvv'],
    ['b6gs73xg2.txt', 'toolu_01AVH9QdZZWXtLAU91eLgbjQ'],
  ];

  const SESSION = '/archive/-slug/sess-1';

  it('no measured basename is derivable from its tool_use_id', () => {
    for (const [base, id] of MEASURED) {
      expect(base.startsWith('toolu_'), base).toBe(false);
      expect(base, base).not.toBe(`${id}.txt`);
    }
  });

  it.each(MEASURED)('resolves %s without ever consulting the tool_use_id', (base, id) => {
    const declared = `/home/USER/.claude/projects/-slug/sess-1/tool-results/${base}`;
    const real = join(SESSION, 'tool-results', base);
    const line = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] },
      toolUseResult: { persistedOutputPath: declared },
    };

    // The env holds ONLY the true file. A resolver deriving `<id>.txt` finds
    // nothing here, so this assertion reds on exactly that bug.
    const state = resolvePersistedOutput(line, envWith([real], { sessionRoot: SESSION }));

    expect(state).toMatchObject({ kind: 'resolved', path: real });
  });

  it('a resolver keyed on tool_use_id would find nothing — the control', () => {
    // Proves the table above is not vacuous: the derived path is absent from the
    // same env in every measured row.
    for (const [base, id] of MEASURED) {
      const derived = join(SESSION, 'tool-results', `${id}.txt`);
      const env = envWith([join(SESSION, 'tool-results', base)], { sessionRoot: SESSION });
      expect(env.exists(derived), derived).toBe(false);
    }
  });
});

describe('AC6 — the ladder climbs to the session root', () => {
  // A marker in `subagents/workflows/wf_*/agent-*.jsonl` has its spill in the
  // GRANDPARENT session directory. Measured: 25 of 43 references sit in a
  // sidecar, "look next to the transcript" resolves 0 of 43, and re-anchoring
  // under the session root resolves 43 of 43.
  const SESSION = '/archive/-slug/sess-1';
  const SIDECAR_DIR = join(SESSION, 'subagents');
  const BASE = 'butub7r77.txt';
  const DECLARED_SIDECAR = `/home/USER/.claude/projects/-slug/sess-1/tool-results/${BASE}`;

  it('recovers a sidecar spill from the session root', () => {
    const real = join(SESSION, 'tool-results', BASE);
    const state = resolvePersistedOutput(
      pointerLine(DECLARED_SIDECAR),
      envWith([real], { sessionRoot: SESSION }),
    );

    expect(state).toMatchObject({ kind: 'resolved', path: real, source: 'pointer' });
  });

  it('"look next to the transcript" is not enough — the control', () => {
    // The spill is NOT beside the sidecar, so a resolver anchored there misses.
    const beside = join(SIDECAR_DIR, 'tool-results', BASE);
    const real = join(SESSION, 'tool-results', BASE);
    expect(beside).not.toBe(real);

    const state = resolvePersistedOutput(
      pointerLine(DECLARED_SIDECAR),
      envWith([beside], { sessionRoot: SESSION }),
    );

    expect(state).toMatchObject({ kind: 'missing', reason: 'not-on-disk' });
  });

  it('falls back to archiveRoot when no sessionRoot resolves', () => {
    const ARCHIVE = '/archive/-slug/sess-9';
    const real = join(ARCHIVE, 'tool-results', BASE);
    const state = resolvePersistedOutput(
      pointerLine(DECLARED_SIDECAR),
      envWith([real], { sessionRoot: SESSION, archiveRoot: ARCHIVE }),
    );

    expect(state).toMatchObject({ kind: 'resolved', path: real });
  });

  it('a marker-sourced path climbs the same ladder', () => {
    const real = join(SESSION, 'tool-results', BASE);
    const state = resolvePersistedOutput(
      markerLine(markerBlock(DECLARED_SIDECAR)),
      envWith([real], { sessionRoot: SESSION }),
    );

    expect(state).toMatchObject({ kind: 'resolved', path: real, source: 'marker' });
  });

  it('with no roots at all it is missing, never a fabricated climb', () => {
    const state = resolvePersistedOutput(pointerLine(DECLARED_SIDECAR), envWith([]));

    expect(state).toEqual({
      kind: 'missing',
      reason: 'not-on-disk',
      declaredPath: DECLARED_SIDECAR,
    });
  });

  it('the ResolveEnv.exists contract covers a SEALED archive file', () => {
    // Ruled 2026-08-13: `exists` means "exists in ANY ARCHIVED FORM". An archived
    // spill can be sealed to `<p>.zst`, and the adapter owns that fallback —
    // without this rule spill resolution reports `missing` for every sealed file.
    const real = join(SESSION, 'tool-results', BASE);
    const sealedOnly: ResolveEnv = {
      sessionRoot: SESSION,
      // Only the `.zst` is on disk; the adapter answers true for the logical path.
      exists: (path) => existsSyncLike([`${real}.zst`], path),
    };

    expect(resolvePersistedOutput(pointerLine(DECLARED_SIDECAR), sealedOnly)).toMatchObject({
      kind: 'resolved',
      path: real,
    });
  });

  /** Stands in for an archive-aware probe: a logical path is present if sealed. */
  function existsSyncLike(onDisk: readonly string[], path: string): boolean {
    return onDisk.includes(path) || onDisk.includes(`${path}.zst`);
  }
});

describe('AC2 — never throws, exhaustively', () => {
  const { proxy, revoke } = Proxy.revocable({ toolUseResult: {} }, {});
  revoke();

  const HOSTILE: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a bare string', 'not a line'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['toolUseResult is a bare string', { toolUseResult: 'stdout text' }],
    ['toolUseResult is null', { toolUseResult: null }],
    ['toolUseResult is an array', { toolUseResult: [] }],
    ['persistedOutputPath is a number', { toolUseResult: { persistedOutputPath: 7 } }],
    ['persistedOutputPath is null', { toolUseResult: { persistedOutputPath: null } }],
    ['persistedOutputPath is empty', { toolUseResult: { persistedOutputPath: '' } }],
    ['message is a bare string', { message: 'hello' }],
    ['content is a bare string', { message: { content: '<persisted-output>' } }],
    ['content is null', { message: { content: null } }],
    ['a block is null', { message: { content: [null] } }],
    ['a block is a string', { message: { content: ['<persisted-output>'] } }],
    [
      'tool_result content is a number',
      { message: { content: [{ type: 'tool_result', content: 1 }] } },
    ],
    ['a revoked Proxy', proxy],
  ];

  it.each(HOSTILE)('%s produces a state, never an exception', (_label, line) => {
    expect(() => resolvePersistedOutput(line, envWith([]))).not.toThrow();
    const state = resolvePersistedOutput(line, envWith([]));
    expect(['resolved', 'missing', 'none']).toContain(state.kind);
  });

  it('a live Proxy whose get trap throws is absorbed too', () => {
    // The case the accessors CANNOT pre-empt: `obj` hands back a real object,
    // and the property read after it is what raises.
    const hostile = new Proxy(
      { toolUseResult: {} },
      {
        get() {
          throw new Error('trap exploded');
        },
      },
    );

    expect(() => resolvePersistedOutput(hostile, envWith([]))).not.toThrow();
    expect(resolvePersistedOutput(hostile, envWith([]))).toEqual({ kind: 'none' });
  });

  it('an exists probe that THROWS cannot take the projection with it', () => {
    const hostile: ResolveEnv = {
      exists: () => {
        throw new Error('probe exploded');
      },
    };

    expect(() => resolvePersistedOutput(pointerLine(DECLARED), hostile)).not.toThrow();
    expect(resolvePersistedOutput(pointerLine(DECLARED), hostile)).toMatchObject({
      kind: 'missing',
    });
  });

  it('an empty declared path never re-anchors onto the spill DIRECTORY', () => {
    // `''` is a value, not an absence. Its basename is also `''`, so an
    // unguarded re-anchor builds `<sessionRoot>/tool-results` — a directory —
    // and a probe answering true for it would report a directory as the spill.
    const SESSION = '/archive/-slug/sess-1';
    const state = resolvePersistedOutput(
      { toolUseResult: { persistedOutputPath: '' } },
      // The probe says yes to the directory and to nothing else.
      { exists: (path) => path === join(SESSION, 'tool-results'), sessionRoot: SESSION },
    );

    expect(state.kind).not.toBe('resolved');
    expect((state as { path?: string }).path).toBeUndefined();
  });

  it('isHarnessTruncated is total too', () => {
    for (const [, line] of HOSTILE) {
      expect(() => isHarnessTruncated(line)).not.toThrow();
    }
    expect(isHarnessTruncated(null)).toBe(false);
    expect(isHarnessTruncated(undefined)).toBe(false);
    expect(isHarnessTruncated(30001)).toBe(false);
  });
});

describe('AC7 — truncation is a BYTE test, never an equality', () => {
  it('the ported multibyte fixture is detected, with all three self-guards', () => {
    // The stored PREFIX is what ends in U+FFFD, not the source string: the cap
    // counts bytes and can cut mid-character. Copied from `merge.test.ts` test 20
    // — `merge.ts` stays live until Task 4.5, so this is a COPY, not a move.
    const prefix = Buffer.from(`x${'中'.repeat(20000)}`)
      .subarray(0, 30000)
      .toString('utf8');

    // Guard the fixture itself. RED against a `=== 30000` byte detector, and RED
    // against a `.length >= 30000` char-count detector: only 10,001 chars.
    expect(Buffer.byteLength(prefix, 'utf8')).toBe(30001);
    expect(prefix.length).toBe(10001);
    expect(prefix.at(-1)).toBe('�');

    expect(isHarnessTruncated(prefix)).toBe(true);
  });

  it('exactly 30,000 bytes is detected — a deliberate conservative over-tag', () => {
    // KNOWN OVER-TAG, documented rather than hidden: `<= 30,000` bytes is passed
    // through whole, but it is the largest inline-able size and the last point at
    // which a genuine spill is indistinguishable from a complete payload.
    const exact = 'x'.repeat(TRUNCATION_BYTES);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(30000);
    expect(isHarnessTruncated(exact)).toBe(true);
  });

  it('an over-tag at exactly 30,000 bytes invents no path', () => {
    // The assertion `merge.test.ts` test 5 banks:
    // `expect(attrsOf(span)).not.toHaveProperty('persisted_output_path')`.
    const line = {
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(TRUNCATION_BYTES) }] },
      toolUseResult: { stdout: 'x'.repeat(TRUNCATION_BYTES), stderr: '' },
    };
    const state = resolvePersistedOutput(line, envWith([]));

    expect(state).toEqual({ kind: 'none' });
    expect(state).not.toHaveProperty('path');
    expect(state).not.toHaveProperty('declaredPath');
  });

  it('29,999 bytes is not truncated', () => {
    expect(isHarnessTruncated('x'.repeat(TRUNCATION_BYTES - 1))).toBe(false);
  });

  it('a 2 KB marker block is detected on the marker signal alone', () => {
    // Two INDEPENDENT signals: this block is far under the byte cap, so a
    // byte-only detector misses it entirely.
    const marker = markerBlock(DECLARED);
    expect(Buffer.byteLength(marker, 'utf8')).toBeLessThan(TRUNCATION_BYTES);
    expect(isHarnessTruncated(marker)).toBe(true);
  });

  it('the constant is the measured cap', () => {
    expect(TRUNCATION_BYTES).toBe(30000);
  });
});

// --- Test 12: the mechanical guard -----------------------------------------

/** One `=== 30000`-shaped comparison found in the source. */
interface Offender {
  line: number;
  text: string;
}

/**
 * Every equality comparison in `text` against the truncation cap — as a literal
 * `30000` OR through an identifier bound in-file to a `const` initialised to it.
 * `text` is DEFAULTED, not read inline, so the mutation controls can drive this
 * exact body with fixture source instead of touching disk.
 */
function equalityAgainstCap(
  file: string,
  text = readFileSync(join(MODULE_DIR, file), 'utf8'),
): Offender[] {
  const source = ts.createSourceFile(join(MODULE_DIR, file), text, ts.ScriptTarget.ESNext, true);

  // Arm (b): identifiers bound to a `const` whose initialiser is 30000.
  const boundToCap = new Set<string>();
  const bind = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isNumericLiteral(node.initializer) &&
      Number(node.initializer.text) === TRUNCATION_BYTES
    ) {
      boundToCap.add(node.name.text);
    }
    ts.forEachChild(node, bind);
  };
  bind(source);

  const isCap = (node: ts.Expression): boolean =>
    (ts.isNumericLiteral(node) && Number(node.text) === TRUNCATION_BYTES) ||
    (ts.isIdentifier(node) && boundToCap.has(node.text));

  const EQUALITY = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

  const offenders: Offender[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      EQUALITY.has(node.operatorToken.kind) &&
      (isCap(node.left) || isCap(node.right))
    ) {
      offenders.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.getText(source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('AC7 — no equality comparison against the truncation cap exists', () => {
  it('spill.ts compares the cap only by inequality', () => {
    expect(
      equalityAgainstCap(SPILL_FILE),
      'truncation must be `>= TRUNCATION_BYTES`. An equality misses the multibyte ' +
        'cut, which stores 30,001 bytes.',
    ).toEqual([]);
  });

  it('the module still names the constant and tests it by inequality', () => {
    // Non-vacuity: a module that stopped mentioning the cap at all would satisfy
    // the assertion above perfectly.
    const text = readFileSync(join(MODULE_DIR, SPILL_FILE), 'utf8');
    expect(text).toContain('TRUNCATION_BYTES');
    expect(text).toMatch(/>=\s*TRUNCATION_BYTES/);
  });
});

describe('the guard reds when the property it protects is broken', () => {
  const SPILL_SRC = readFileSync(join(MODULE_DIR, SPILL_FILE), 'utf8');

  it('the unmutated source, through the same seam, is clean', () => {
    // Proves each mutation below reds because of the mutation, not because
    // feeding the helper fixture text is itself enough to trip it.
    expect(equalityAgainstCap(SPILL_FILE, SPILL_SRC)).toEqual([]);
  });

  it('arm (a): a literal `n === 30000` reds', () => {
    const mutated = `${SPILL_SRC}\nexport const bad = (n: number): boolean => n === 30000;\n`;
    const offenders = equalityAgainstCap(SPILL_FILE, mutated);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.text).toBe('n === 30000');
  });

  it('arm (b): `n === TRUNCATION_BYTES` reds too — the bug a grep would miss', () => {
    // Load-bearing. A plain `grep '=== 30000'` is defeated by the constant name
    // `merge.ts:76` already uses, so a grep-only check would be green on the very
    // bug it is named for.
    const mutated = `${SPILL_SRC}\nexport const bad = (n: number): boolean => n === TRUNCATION_BYTES;\n`;
    const offenders = equalityAgainstCap(SPILL_FILE, mutated);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.text).toBe('n === TRUNCATION_BYTES');
  });

  it.each(['!==', '==', '!='])('the %s form reds as well', (operator) => {
    const mutated = `${SPILL_SRC}\nexport const bad = (n: number): boolean => n ${operator} TRUNCATION_BYTES;\n`;
    expect(equalityAgainstCap(SPILL_FILE, mutated)).toHaveLength(1);
  });

  it('the AST ignores comments, which is why the module can document the trap', () => {
    // `merge.ts:73` contains the literal text `=== 30000` INSIDE a doc comment
    // explaining why not to write it, and spill.ts carries the same explanation.
    // A text guard would red on its own documentation.
    const commented = `${SPILL_SRC}\n// never write n === 30000 here\n`;
    expect(equalityAgainstCap(SPILL_FILE, commented)).toEqual([]);
    expect(commented).toContain('=== 30000');
  });

  it('an inequality against the cap is NOT an offender', () => {
    const fine = `${SPILL_SRC}\nexport const ok = (n: number): boolean => n >= TRUNCATION_BYTES;\n`;
    expect(equalityAgainstCap(SPILL_FILE, fine)).toEqual([]);
  });
});

// --- Test 13: the frozen fixtures, existsSync-gated -------------------------

const REPO_ROOT = dirname(dirname(MODULE_DIR));
const SCRUBBED = join(REPO_ROOT, 'fixtures', 'scrubbed');

/** Every structured spill reference in a scrubbed fixture transcript. */
function frozenReferences(): { line: unknown; sessionRoot: string }[] {
  const found: { line: unknown; sessionRoot: string }[] = [];
  for (const set of ['large-output', 'compaction', 'subagent', 'multi-turn']) {
    const transcript = join(SCRUBBED, set, 'transcripts', 'parent.jsonl');
    if (!existsSync(transcript)) continue;
    // The spill dir is a SIBLING of `transcripts/`, not a child — that is the
    // layout `capture.mjs` writes and the one `.gitignore` names. It is
    // GITIGNORED since #44 (two 10 MB spills), so this tier must never assume
    // the files exist on a fresh clone.
    const spillDir = join(SCRUBBED, set, 'tool-results');
    if (!existsSync(spillDir)) continue;

    for (const raw of readFileSync(transcript, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      const tur = (line as { toolUseResult?: { persistedOutputPath?: unknown } })?.toolUseResult;
      if (typeof tur?.persistedOutputPath === 'string') {
        found.push({ line, sessionRoot: join(SCRUBBED, set) });
      }
    }
  }
  return found;
}

const FROZEN = frozenReferences();
const frozenIt = FROZEN.length > 0 ? it : it.skip;

describe('the frozen fixtures resolve under sessionRoot and are missing without it', () => {
  frozenIt('every frozen marker resolves when the session root is supplied', () => {
    const probe: ResolveEnv['exists'] = (path) => existsSync(path) || existsSync(`${path}.zst`);

    for (const { line, sessionRoot } of FROZEN) {
      const state = resolvePersistedOutput(line, { exists: probe, sessionRoot });
      expect(state.kind, JSON.stringify(state)).toBe('resolved');
    }
  });

  frozenIt('without a session root every one is missing — the scrub path is not real', () => {
    // The scrubbed transcripts declare `/home/USER/...`, which exists nowhere.
    const probe: ResolveEnv['exists'] = (path) => existsSync(path);

    for (const { line } of FROZEN) {
      const state = resolvePersistedOutput(line, { exists: probe });
      expect(state).toMatchObject({ kind: 'missing', reason: 'not-on-disk' });
      expect((state as { declaredPath?: string }).declaredPath).toContain('/home/USER/');
    }
  });
});

// --- Test 14: the archive invariant tier, opt-in ----------------------------

const REAL_CORPUS = process.env['AGENT_LENS_REAL_CORPUS'] === '1';
const corpusIt = REAL_CORPUS ? it : it.skip;

function archivedTranscripts(root: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) archivedTranscripts(path, out);
    else if (entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** A sidecar's session root is its GRANDPARENT; a main transcript's is its stem. */
function sessionRootOf(file: string): string {
  const parent = dirname(file);
  if (basename(parent) === 'subagents') return dirname(parent);
  return join(parent, basename(file, '.jsonl'));
}

describe('AC2 — the archive invariant (AGENT_LENS_REAL_CORPUS=1)', () => {
  corpusIt(
    'resolved + missing === totalReferenced, with 0 exceptions',
    () => {
      const root = join(homedir(), '.agent-lens', 'archive');
      // "Exists in ANY ARCHIVED FORM": a sealed spill is present as `<p>.zst`.
      const exists = (path: string): boolean => existsSync(path) || existsSync(`${path}.zst`);

      let totalReferenced = 0;
      let resolved = 0;
      let missing = 0;
      let none = 0;
      const threw: string[] = [];
      const sources = { pointer: 0, marker: 0 };

      for (const file of archivedTranscripts(root)) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const sessionRoot = sessionRootOf(file);

        for (const raw of text.split('\n')) {
          if (raw.trim() === '') continue;
          let line: unknown;
          try {
            line = JSON.parse(raw);
          } catch {
            continue;
          }

          let state: SpillState;
          try {
            state = resolvePersistedOutput(line, { exists, sessionRoot });
          } catch (error) {
            threw.push(`${file}: ${String(error)}`);
            continue;
          }

          if (state.kind === 'none') {
            none++;
            continue;
          }
          totalReferenced++;
          if (state.kind === 'resolved') {
            resolved++;
            sources[state.source]++;
            // A resolved state always names a path that the probe agrees exists.
            expect(exists(state.path), state.path).toBe(true);
          } else {
            missing++;
            // A missing state NEVER carries a usable path.
            expect((state as { path?: string }).path).toBeUndefined();
          }
        }
      }

      // Counts are DIAGNOSTICS, printed and asserted NEVER — they change as the
      // archive grows and as history expires.
      console.log(
        `[spill] referenced=${totalReferenced} resolved=${resolved} missing=${missing} ` +
          `none=${none} pointer=${sources.pointer} marker=${sources.marker}`,
      );

      // The load-bearing assertions. They stay true at 0 missing, at 53 missing,
      // and after the archive drives missing to 0 permanently.
      expect(threw).toEqual([]);
      expect(totalReferenced).toBeGreaterThan(0);
      expect(resolved + missing).toBe(totalReferenced);
    },
    120000,
  );
});
