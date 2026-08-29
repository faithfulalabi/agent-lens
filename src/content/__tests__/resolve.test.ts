// AC1-AC4 for the content resolver, hermetically.
//
// Every fixture is SYNTHETIC. The arms that need a production row project one
// through the real pipeline rather than hand-writing storage columns, because
// the three subtle facts this module encodes — the result line's coordinates,
// the absent `missing` preview, the dangling `spill_path` — are all facts about
// what the projector actually writes.
//
// The reads are traced through a wrapping `ArchiveReader`, so "exactly one
// pread, at these coordinates, on the archive" is asserted rather than hoped.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import {
  cleanup,
  compressLikeSeal,
  makeSandbox,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { createArchiveReader, type ArchiveReader } from '../../archive/read.js';
import { foldArchive } from '../../db/freshness.js';
import { readEventArchivePath, readEventContentRow, type EventContentRow } from '../../db/read.js';
import { projectSession } from '../../db/write.js';
import {
  CWD,
  fileEnv,
  humanLine,
  nextUuid,
  openCache,
  SESSION_ID,
  seedIndexRow,
  spillMarker,
  toolCallLine,
  toolResultLine,
  writeFile,
  writeSidecarTranscript,
  writeTranscript,
} from '../../db/__tests__/fixtures/index.js';
import { INLINE_MAX } from '../../project/tools.js';
import { clampRange, type ContentResolver } from '../../server/api.js';
import {
  createContentEnv,
  createContentResolver,
  resolveContent,
  type ContentEnv,
  type ContentField,
} from '../resolve.js';

const RESOLVE_TS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'resolve.ts');
const SOURCE = readFileSync(RESOLVE_TS, 'utf8');

/** The module's CODE, comments stripped. The textual guards below are about what
 *  it DOES; a doc comment naming `DatabaseSync` to say it never sees one must
 *  not red the guard that says it never sees one. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** The whole answer shape, sorted. Set equality, never containment. */
const SLICE_KEYS = ['byte_size', 'content', 'storage'];

let sandbox: Sandbox | undefined;
const open: DatabaseSync[] = [];

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

function cache(): DatabaseSync {
  const db = openCache();
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  if (sandbox !== undefined) cleanup(sandbox);
  sandbox = undefined;
});

const TS = (seconds: number): string =>
  new Date(Date.UTC(2026, 7, 25, 9, 0, seconds)).toISOString();

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

// --- tracing reader ---------------------------------------------------------

interface Trace {
  path: string;
  offset: number;
  length: number;
  bytes: number;
}

/** The real reader, wrapped. Records the COORDINATES, which `countingReader`
 *  (`fixtures/index.ts:207`) does not, and which is the whole point of AC1. */
function tracingReader(log: Trace[], inner: ArchiveReader = createArchiveReader()): ArchiveReader {
  return {
    read: (path, offset, length) => {
      const buf = inner.read(path, offset, length);
      log.push({ path, offset, length, bytes: buf.length });
      return buf;
    },
    size: (path) => inner.size(path),
    stats: () => inner.stats(),
  };
}

function tracingEnv(log: Trace[], inner?: ArchiveReader): ContentEnv {
  return { ...createContentEnv(inner ?? createArchiveReader()), reader: tracingReader(log, inner) };
}

// --- row and transcript builders --------------------------------------------

/** Every column NULL but the two `NOT NULL` coordinates. */
function row(over: Partial<EventContentRow> = {}): EventContentRow {
  return {
    id: 'ev-1',
    session_id: SESSION_ID,
    block_index: 0,
    input: null,
    input_bytes: null,
    input_storage: null,
    text: null,
    text_bytes: null,
    output_storage: null,
    spill_path: null,
    spill_bytes: null,
    src_offset: 0,
    src_len: 0,
    result_offset: null,
    result_len: null,
    result_block: null,
    ...over,
  };
}

function envelope(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: nextUuid(),
    parentUuid: null,
    sessionId: SESSION_ID,
    version: '2.1.212',
    cwd: CWD,
    gitBranch: 'main',
    ...fields,
  };
}

/** A `tool_use` whose input the caller sizes — `toolCallLine`'s is fixed small. */
function bigCallLine(
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Record<string, unknown> {
  return envelope({
    type: 'assistant',
    timestamp: at,
    requestId: `req-${callId}`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', id: callId, name: 'Bash', input }],
    },
  });
}

/** A `tool_result` carrying SEVERAL text children — the `'\n'` join's witness. */
function multiChildResultLine(
  callId: string,
  texts: readonly string[],
  at: string,
): Record<string, unknown> {
  return envelope({
    type: 'user',
    timestamp: at,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content: texts.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  });
}

/** A transcript under the sandbox archive, projected. Returns the db and path. */
function plant(name: string, records: readonly unknown[]): { path: string; dir: string } {
  const path = join(sb().archiveRoot, `${name}.jsonl`);
  writeTranscript(path, records);
  return { path, dir: path.slice(0, -'.jsonl'.length) };
}

/** `before` runs after the transcript exists and BEFORE projection, which is the
 *  only moment a spill file can be planted for the projector's probe to find. */
function project(
  records: readonly unknown[],
  name = 'session',
  before?: () => void,
): { db: DatabaseSync; id: string; path: string; dir: string } {
  const db = cache();
  const { path, dir } = plant(name, records);
  before?.();
  const id = seedIndexRow(db, path);
  projectSession(db, id, fileEnv(), foldArchive(path)!);
  return { db, id, path, dir };
}

/** Where `plant(name, …)` will put the session's sibling directory. */
function dirFor(name: string): string {
  return join(sb().archiveRoot, name);
}

function contentRow(db: DatabaseSync, id: string): EventContentRow {
  const found = readEventContentRow(db, id);
  expect(found, `no content row for ${id}`).toBeDefined();
  return found!;
}

/** A payload comfortably over `INLINE_MAX`, so the projector stores a `line_ref`. */
function oversized(seed: string): string {
  return seed.repeat(Math.ceil((INLINE_MAX + 4096) / seed.length));
}

// --- AC1: every storage state resolves --------------------------------------

describe('AC1 — the column states resolve from the row alone', () => {
  const env = createContentEnv();

  it('1. inline returns the column, on both fields, and sizes it from *_bytes', () => {
    const text = resolveContent(
      row({ text: 'stored output', text_bytes: 13, output_storage: 'inline' }),
      'text',
      undefined,
      env,
    );
    expect(keysOf(text)).toEqual(SLICE_KEYS);
    expect(text).toEqual({ storage: 'inline', content: 'stored output', byte_size: 13 });

    const input = resolveContent(
      row({ input: '{"pattern":"x"}', input_bytes: 15, input_storage: 'inline' }),
      'input',
      undefined,
      env,
    );
    expect(input).toEqual({ storage: 'inline', content: '{"pattern":"x"}', byte_size: 15 });
  });

  it('2. NULL output_storage — the commonest row — reports inline and sizes the column', () => {
    // `pipeline.ts:490` sets the column only on tool_call rows, so every other
    // row carries NULL storage, NULL text_bytes and its full uncapped text.
    const slice = resolveContent(row({ text: 'héllo', text_bytes: null }), 'text', undefined, env);
    expect(slice).toEqual({ storage: 'inline', content: 'héllo', byte_size: 6 });
    expect(slice.byte_size).not.toBe('héllo'.length);
  });

  it('3. absent and NULL input_storage both answer with an empty payload', () => {
    for (const storage of ['absent', null]) {
      expect(resolveContent(row({ input_storage: storage }), 'input', undefined, env)).toEqual({
        storage: 'absent',
        content: '',
        byte_size: 0,
      });
    }
    expect(resolveContent(row({ output_storage: 'absent' }), 'text', undefined, env)).toEqual({
      storage: 'absent',
      content: '',
      byte_size: 0,
    });
  });
});

describe('AC1 — line_ref preads the archive', () => {
  const INPUT = { command: oversized('echo the-input-payload '), description: 'big' };

  function lineRefInput(): { db: DatabaseSync; id: string; path: string; row: EventContentRow } {
    const { db, id, path } = project([
      humanLine('run it', TS(0)),
      bigCallLine('toolu_big', INPUT, TS(1)),
      toolResultLine('toolu_big', 'small answer', TS(2)),
    ]);
    return { db, id, path, row: contentRow(db, 'toolu_big') };
  }

  it('4. field=input preads the EMITTING line, once, on the archive', () => {
    const { path, row: content } = lineRefInput();
    expect(content.input_storage).toBe('line_ref');

    const log: Trace[] = [];
    const slice = resolveContent(content, 'input', path, tracingEnv(log));

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      path,
      offset: content.src_offset,
      length: content.src_len,
      bytes: content.src_len,
    });
    // The archive, and only the archive: no source-corpus path is ever opened.
    expect([...new Set(log.map((entry) => entry.path))]).toEqual([path]);
    expect(log[0]!.bytes).toBeLessThan(readFileSync(path).byteLength);

    expect(slice.storage).toBe('line_ref');
    expect(slice.content).toBe(JSON.stringify(INPUT));
    expect(slice.byte_size).toBe(content.input_bytes);
  });

  it('5. field=text preads the RESULT line, not src_offset — with a mutation control', () => {
    const HEAD = oversized('the result payload ');
    const { db, path } = project([
      humanLine('run it', TS(0)),
      toolCallLine('toolu_r', 'Bash', TS(1)),
      multiChildResultLine('toolu_r', [HEAD, 'tail'], TS(2)),
    ]);
    const content = contentRow(db, 'toolu_r');
    expect(content.output_storage).toBe('line_ref');
    // The two coordinate pairs are genuinely different lines, so the assertion
    // below can discriminate at all.
    expect(content.result_offset).not.toBe(content.src_offset);

    const log: Trace[] = [];
    const slice = resolveContent(content, 'text', path, tracingEnv(log));

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      path,
      offset: content.result_offset,
      length: content.result_len,
    });
    expect(slice.content).toBe(`${HEAD}\ntail`);
    expect(slice.byte_size).toBe(content.text_bytes);

    // ★ MUTATION CONTROL. A resolver reading the EMITTING line's pair returns
    // different bytes, which is what proves the assertion above discriminates.
    const wrong = resolveContent(
      { ...content, result_offset: content.src_offset, result_len: content.src_len },
      'text',
      path,
      createContentEnv(),
    );
    expect(wrong.content).not.toBe(slice.content);
    // The emitting line holds a `tool_use`, not a `tool_result`, so the arm
    // degrades to the stored preview rather than returning a wrong body.
    expect(wrong.content).toBe(content.text);

    // And the block index discriminates too.
    const wrongBlock = resolveContent(
      { ...content, result_block: 99 },
      'text',
      path,
      createContentEnv(),
    );
    expect(wrongBlock.content).toBe(content.text);
  });

  it('6. an unreachable archive degrades to the stored preview at the TRUE byte_size', () => {
    const { path, row: content } = lineRefInput();
    rmSync(path);

    const slice = resolveContent(content, 'input', path, createContentEnv());
    expect(slice.storage).toBe('line_ref');
    expect(slice.content).toBe(content.input);
    // The size stays honest, so the route's `truncated` flag is still right.
    expect(slice.byte_size).toBe(content.input_bytes);
    expect(slice.byte_size).toBeGreaterThan(Buffer.byteLength(slice.content, 'utf8'));
  });
});

describe('AC1 — exactly one call into the line parser, and no SQL', () => {
  it('7. the module names classifyLine once and imports neither node:sqlite nor a db', () => {
    const source = ts.createSourceFile(RESOLVE_TS, SOURCE, ts.ScriptTarget.ESNext, true);

    let calls = 0;
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'classifyLine') {
        calls += 1;
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(calls).toBe(1);
    expect(specifiers).not.toContain('node:sqlite');
    // Zero bytes reach SQLite because no SQLite handle can reach this module.
    expect(CODE).not.toMatch(/DatabaseSync/);
    expect(CODE).not.toMatch(/\bprepare\b/);
  });

  it('8. resolving twice preads twice and parses once per resolve', () => {
    const { db, path } = project([
      humanLine('go', TS(0)),
      bigCallLine('toolu_two', { command: oversized('x ') }, TS(1)),
      toolResultLine('toolu_two', 'ok', TS(2)),
    ]);
    const content = contentRow(db, 'toolu_two');

    const log: Trace[] = [];
    const env = tracingEnv(log);
    const first = resolveContent(content, 'input', path, env);
    expect(log).toHaveLength(1);
    const second = resolveContent(content, 'input', path, env);
    expect(log).toHaveLength(2);
    expect(second).toEqual(first);
  });
});

// --- AC1/AC2: spill and missing ---------------------------------------------

describe('AC1 — spill resolves, archive mirror first', () => {
  const BODY = 'the whole spilled output, several lines\nof it\n';
  const SPILL_NAME = 'b1a2c3d4.txt';
  /** The shape every measured row has today: a `~/.claude/` source path, which
   *  Claude Code expires at ~41 days while the archive keeps its mirror. */
  const DECLARED = `/Users/dev/.claude/projects/-Users-dev-proj/x/tool-results/${SPILL_NAME}`;
  const NAME = 'spills';

  /** A projected spill row whose mirror existed when the projector probed. */
  function spillSession(): { db: DatabaseSync; path: string; dir: string; mirror: string } {
    const mirror = join(dirFor(NAME), 'tool-results', SPILL_NAME);
    const { db, path, dir } = project(
      [
        humanLine('spill it', TS(0)),
        toolCallLine('toolu_spill', 'Bash', TS(1)),
        toolResultLine('toolu_spill', spillMarker(DECLARED), TS(2), {
          toolUseResult: { persistedOutputPath: DECLARED, persistedOutputSize: 999 },
        }),
      ],
      NAME,
      () => writeFile(mirror, BODY),
    );
    return { db, path, dir, mirror };
  }

  it('9. reads the archive mirror, and sizes from the file not from spill_bytes', () => {
    const { db, path, mirror } = spillSession();
    const content = contentRow(db, 'toolu_spill');
    expect(content.output_storage).toBe('spill');

    const slice = resolveContent(content, 'text', path, createContentEnv());
    expect(slice).toEqual({
      storage: 'spill',
      content: BODY,
      byte_size: Buffer.byteLength(BODY, 'utf8'),
      spill_path: mirror,
    });
    // `spill_bytes` is the harness's DECLARED size and disagrees; the file wins.
    expect(content.spill_bytes).toBe(999);
    expect(slice.byte_size).not.toBe(999);
  });

  it('10. a dangling SOURCE path still resolves, from the mirror', () => {
    const { path, mirror } = spillSession();

    const slice = resolveContent(
      row({ output_storage: 'spill', spill_path: DECLARED }),
      'text',
      path,
      createContentEnv(),
    );
    expect(slice.spill_path).toBe(mirror);
    expect(slice.content).toBe(BODY);
  });

  it('11. falls back to the recorded path when the archive has no mirror', () => {
    const { path } = project([humanLine('no mirror here', TS(0))], 'no-mirror');
    const loose = writeFile(join(sb().root, 'loose', 'tool-results', SPILL_NAME), BODY);

    const slice = resolveContent(
      row({ output_storage: 'spill', spill_path: loose }),
      'text',
      path,
      createContentEnv(),
    );
    expect(slice.spill_path).toBe(loose);
    expect(slice.content).toBe(BODY);
  });

  it('12. ★ a SIDECAR anchors at the session root — its grandparent, not its own dir', () => {
    // 34 of 53 measured spill references sit in a sidecar, and 0 of 65 archive
    // `tool-results/` directories sit under `subagents/`. Anchoring beside the
    // transcript resolves 19 of 53; anchoring at the session root resolves 53.
    const { dir, mirror } = spillSession();
    const dangling = row({ output_storage: 'spill', spill_path: DECLARED });

    const flat = writeSidecarTranscript(join(dir, 'subagents'), 'kid', [
      humanLine('child work', TS(3)),
    ]);
    expect(resolveContent(dangling, 'text', flat, createContentEnv())).toMatchObject({
      spill_path: mirror,
      content: BODY,
    });

    // The same rule reaches into the `subagents/workflows/wf_*/` pocket.
    const nested = writeSidecarTranscript(join(dir, 'subagents', 'workflows', 'wf_1'), 'deep', [
      humanLine('deeper', TS(4)),
    ]);
    expect(resolveContent(dangling, 'text', nested, createContentEnv()).spill_path).toBe(mirror);

    // The control: the path a "look next to the transcript" anchor would build
    // is not on disk and is not what was served. That is the whole defect.
    const naive = join(flat.slice(0, -'.jsonl'.length), 'tool-results', SPILL_NAME);
    expect(existsSync(naive)).toBe(false);
    expect(mirror).not.toBe(naive);
  });
});

describe('AC2 — missing is a 200-shaped answer and an ordinary path', () => {
  it('13. a projected missing row carries no preview, no size and no spill_path key', () => {
    // Driven through the REAL projector, so the row is the one production writes:
    // `write.ts:453` leaves text, spill_path and spill_bytes all NULL.
    const { db, path } = project([
      humanLine('lose it', TS(0)),
      toolCallLine('toolu_lost', 'Bash', TS(1)),
      toolResultLine('toolu_lost', spillMarker('/gone/tool-results/vanished.txt'), TS(2)),
    ]);
    const content = contentRow(db, 'toolu_lost');
    expect(content.output_storage).toBe('missing');
    expect(content.text).toBeNull();
    expect(content.spill_path).toBeNull();

    let slice!: ReturnType<typeof resolveContent>;
    expect(() => {
      slice = resolveContent(content, 'text', path, createContentEnv());
    }).not.toThrow();

    expect(slice).toEqual({ storage: 'missing', content: '', byte_size: 0 });
    expect(keysOf(slice)).not.toContain('spill_path');
  });

  it('14. a spill whose file has vanished degrades to missing, and never throws', () => {
    const spill = join(dirFor('vanish'), 'tool-results', 'g.txt');
    const { db, path } = project(
      [
        humanLine('spill then lose', TS(0)),
        toolCallLine('toolu_gone', 'Bash', TS(1)),
        toolResultLine('toolu_gone', spillMarker(spill), TS(2), {
          toolUseResult: { persistedOutputPath: spill },
        }),
      ],
      'vanish',
      () => writeFile(spill, 'a body that is about to be expired'),
    );
    const content = contentRow(db, 'toolu_gone');
    expect(content.output_storage).toBe('spill');
    expect(content.spill_path).toBe(spill);

    // Delete the body WITHOUT touching the transcript, so the archive-derived
    // freshness key never invalidates and the row is never reprojected. This is
    // the guaranteed future state of every `spill_path` in the DB today.
    rmSync(spill);

    let slice!: ReturnType<typeof resolveContent>;
    expect(() => {
      slice = resolveContent(content, 'text', path, createContentEnv());
    }).not.toThrow();
    expect(slice).toEqual({ storage: 'missing', content: '', byte_size: 0 });
  });

  it('15. a probe that lies is caught, not propagated', () => {
    const { path } = project([humanLine('nothing spilled', TS(0))], 'liar');
    const lying: ContentEnv = { reader: createArchiveReader(), exists: () => true };

    const slice = resolveContent(
      row({ output_storage: 'spill', spill_path: join(sb().root, 'never-written.txt') }),
      'text',
      path,
      lying,
    );
    expect(slice).toEqual({ storage: 'missing', content: '', byte_size: 0 });
  });

  it('16. a probe that throws is caught too', () => {
    const throwing: ContentEnv = {
      reader: createArchiveReader(),
      exists: () => {
        throw new Error('probe exploded');
      },
    };
    expect(
      resolveContent(
        row({ output_storage: 'spill', spill_path: '/x.txt' }),
        'text',
        '/a.jsonl',
        throwing,
      ),
    ).toEqual({ storage: 'missing', content: '', byte_size: 0 });
  });

  it('17. the module names no status code and contains no throw at all', () => {
    expect(CODE).not.toMatch(/\b404\b/);
    expect(CODE).not.toMatch(/\b500\b/);
    // Not "no reachable throw" — none, anywhere. Every failure is a label.
    expect(CODE).not.toMatch(/\bthrow\b/);
  });
});

// --- AC3: the range composition ---------------------------------------------

describe('AC3 — byte_size is the true size, so the route ranges correctly', () => {
  /** What `server/api.ts:471-481` does with a resolved answer. */
  function serve(
    slice: { content: string; byte_size: number },
    raw: { start: number; end?: number } | undefined,
  ): { content: string; range: { start: number; end: number }; truncated: boolean } {
    const bytes = Buffer.from(slice.content, 'utf8');
    const clamped = clampRange(raw, bytes.length);
    return {
      content: bytes.subarray(clamped.start, clamped.start + clamped.length).toString('utf8'),
      range: { start: clamped.start, end: clamped.end },
      truncated: clamped.length < slice.byte_size,
    };
  }

  it('18. an omitted range serves the whole payload, untruncated', () => {
    const slice = resolveContent(
      row({ text: 'a'.repeat(100), text_bytes: 100, output_storage: 'inline' }),
      'text',
      undefined,
      createContentEnv(),
    );
    expect(serve(slice, undefined)).toMatchObject({
      range: { start: 0, end: 99 },
      truncated: false,
    });
  });

  it('19. out of bounds clamps rather than rejects, on every reading state', () => {
    const { db, path } = project([
      humanLine('range me', TS(0)),
      toolCallLine('toolu_rng', 'Bash', TS(1)),
      multiChildResultLine('toolu_rng', [oversized('range payload ')], TS(2)),
    ]);
    const content = contentRow(db, 'toolu_rng');
    const slice = resolveContent(content, 'text', path, createContentEnv());

    // A length past the end truncates; a start past the end is an empty slice.
    expect(serve(slice, { start: 0, end: 9 }).content).toHaveLength(10);
    expect(serve(slice, { start: slice.byte_size + 50 }).content).toBe('');
    expect(serve(slice, { start: slice.byte_size + 50 }).range.end).toBe(slice.byte_size - 1);
    expect(serve(slice, { start: 0, end: slice.byte_size * 2 }).truncated).toBe(false);
  });

  it('20. a range is a BYTE range, and a split multi-byte seam decodes non-fatally', () => {
    const EMOJI = '🙂🙂🙂';
    const slice = resolveContent(
      row({ text: EMOJI, text_bytes: null }),
      'text',
      undefined,
      createContentEnv(),
    );
    // Four bytes per emoji, one JS char pair each: the size is a BYTE count.
    expect(slice.byte_size).toBe(12);
    expect(slice.byte_size).not.toBe(EMOJI.length);

    // Cut two bytes into a four-byte character. U+FFFD at the seam is the honest
    // answer and the decode is non-fatal — it never throws and never returns ''.
    const seam = serve(slice, { start: 0, end: 1 });
    expect(seam.content).toBe('�');
    // A whole-character range is exact, which is what proves the seam above was
    // the split and not a decoder that mangles everything.
    expect(serve(slice, { start: 0, end: 3 }).content).toBe('🙂');
    expect(serve(slice, { start: 4, end: 11 }).content).toBe('🙂🙂');
  });

  it('21. the clamp never leaves the payload, at any size and any range', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 64 }),
        fc.integer({ min: 0, max: 80 }),
        fc.integer({ min: 0, max: 80 }),
        (text, start, span) => {
          const slice = resolveContent(
            row({ text, text_bytes: null }),
            'text',
            undefined,
            createContentEnv(),
          );
          const clamped = clampRange({ start, end: start + span }, slice.byte_size);
          expect(clamped.length).toBeGreaterThanOrEqual(0);
          expect(clamped.start + clamped.length).toBeLessThanOrEqual(slice.byte_size);
          expect(clamped.length < slice.byte_size).toBe(
            serve(slice, { start, end: start + span }).truncated,
          );
          // The served bytes never exceed what was clamped.
          expect(
            Buffer.byteLength(serve(slice, { start, end: start + span }).content, 'utf8'),
          ).toBeLessThanOrEqual(Math.max(clamped.length * 3, 0));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- AC4: the seal ----------------------------------------------------------

describe('AC4 — a sealed archive answers byte-identically to a hot one', () => {
  /** Replace a hot file with the frame `sealArchiveFile` would have written. */
  function seal(path: string): void {
    writeFileSync(`${path}.zst`, compressLikeSeal(readFileSync(path)));
    rmSync(path);
  }

  it('22. line_ref on both fields survives the seal, whole and ranged', () => {
    const INPUT = { command: oversized('sealed input ') };
    const OUT = oversized('sealed output ');
    const { db, path } = project([
      humanLine('seal it', TS(0)),
      bigCallLine('toolu_seal', INPUT, TS(1)),
      multiChildResultLine('toolu_seal', [OUT, 'tail'], TS(2)),
    ]);
    const content = contentRow(db, 'toolu_seal');

    const hot = (field: ContentField) =>
      resolveContent(content, field, path, createContentEnv(createArchiveReader()));
    const hotText = hot('text');
    const hotInput = hot('input');

    seal(path);

    // The LOGICAL path is unchanged — the caller never learns the file moved.
    const reader = createArchiveReader();
    const sealedEnv = createContentEnv(reader);
    expect(resolveContent(content, 'text', path, sealedEnv)).toEqual(hotText);
    expect(resolveContent(content, 'input', path, sealedEnv)).toEqual(hotInput);
    // A control: the sealed limb was actually taken.
    expect(reader.stats().misses).toBeGreaterThan(0);
  });

  it('23. a sealed spill resolves, and its byte_size is the LOGICAL size', () => {
    const BODY = oversized('sealed spill body ');
    const declared = '/gone/tool-results/sealed.txt';
    const mirror = join(dirFor('sealed-spill'), 'tool-results', basename(declared));
    const { path } = project(
      [
        humanLine('spill and seal', TS(0)),
        toolCallLine('toolu_ss', 'Bash', TS(1)),
        toolResultLine('toolu_ss', spillMarker(declared), TS(2), {
          toolUseResult: { persistedOutputPath: declared },
        }),
      ],
      'sealed-spill',
      () => writeFile(mirror, BODY),
    );
    const content = row({ output_storage: 'spill', spill_path: declared });

    const hot = resolveContent(content, 'text', path, createContentEnv());
    expect(hot.storage).toBe('spill');

    seal(mirror);
    const sealed = resolveContent(content, 'text', path, createContentEnv());

    // Byte-identical, including `byte_size` — the LOGICAL length in both states.
    expect(sealed).toEqual(hot);
    expect(sealed.byte_size).toBe(Buffer.byteLength(BODY, 'utf8'));
  });
});

// --- the drift closer -------------------------------------------------------

describe('AC1 — the re-derived resultText agrees with the projector', () => {
  it('24. ★ joins several text children on \\n and does NOT trim', () => {
    // The only thing pinning this module's mapping to `pipeline.ts:264-266`, and
    // it runs under plain `npm test`. A corpus differential closes nothing:
    // measured, 0 of 16,440 tool_result payloads exceed INLINE_MAX, so the
    // `line_ref` arm has no real row to run on.
    const HEAD = `  ${oversized('leading space kept ')}`;
    const CHILDREN = [HEAD, 'second child', '', 'fourth child  '];
    const { db, path } = project([
      humanLine('drift', TS(0)),
      toolCallLine('toolu_drift', 'Bash', TS(1)),
      multiChildResultLine('toolu_drift', CHILDREN, TS(2)),
    ]);
    const content = contentRow(db, 'toolu_drift');
    expect(content.output_storage).toBe('line_ref');

    const slice = resolveContent(content, 'text', path, createContentEnv());

    // The join, verbatim: '\n' between every child including the empty one.
    expect(slice.content).toBe(CHILDREN.join('\n'));
    // NOT trimmed at either end — both marker predicates test index 0 and
    // `text_bytes` was sized off this exact string.
    expect(slice.content.startsWith('  ')).toBe(true);
    expect(slice.content.endsWith('  ')).toBe(true);
    // And the projector's own size agrees with the re-derived bytes.
    expect(content.text_bytes).toBe(Buffer.byteLength(slice.content, 'utf8'));
    // The stored column is only a head preview of it.
    expect(slice.content.startsWith(content.text!)).toBe(true);
  });
});

// --- the seam ---------------------------------------------------------------

describe('the resolver fits 4.3’s ApiDeps seam', () => {
  it('25. createContentResolver is assignable to ContentResolver and finds its own path', () => {
    const { db, path } = project([
      humanLine('seam', TS(0)),
      bigCallLine('toolu_seam', { command: oversized('seam ') }, TS(1)),
      toolResultLine('toolu_seam', 'ok', TS(2)),
    ]);
    const content = contentRow(db, 'toolu_seam');

    // The compile-time half: this assignment is the assertion.
    const resolver: ContentResolver = createContentResolver(
      (session_id) => readEventArchivePath(db, session_id)?.archive_path,
    );

    const slice = resolver(content, 'input');
    expect(slice.storage).toBe('line_ref');
    expect(slice.content).toBe(resolveContent(content, 'input', path, createContentEnv()).content);
  });

  it('26. an unknown session degrades instead of throwing', () => {
    const { db } = project([humanLine('orphan', TS(0))], 'orphan');
    const resolver = createContentResolver(
      (session_id) => readEventArchivePath(db, session_id)?.archive_path,
    );
    expect(
      resolver(
        row({ session_id: 'no-such-session', output_storage: 'line_ref', text: 'head' }),
        'text',
      ),
    ).toEqual({ storage: 'line_ref', content: 'head', byte_size: 4 });
  });
});

// --- standing guards --------------------------------------------------------

describe('the standing guards this tree must not move', () => {
  it('27. src/content has no barrel', () => {
    expect(() => readFileSync(join(dirname(RESOLVE_TS), 'index.ts'))).toThrow();
  });
});
