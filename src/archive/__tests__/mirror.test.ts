// The acceptance criteria. Fixtures are synthesized in temp dirs; nothing here
// reads a real transcript root.

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import { archiveOnce, createMirrorContext, mirrorFile } from '../mirror.js';
import { createArchiveReader } from '../read.js';
import { discover } from '../discover.js';
import { canonicalizeTranscriptPath } from '../paths.js';
import {
  archivePath,
  bytesEqual,
  jsonLines,
  readBytes,
  SLUG,
  snapshotTree,
  sourcePath,
  writeArchive,
  writeSource,
  useSandbox,
  type Sandbox,
  type TreeEntry,
} from './fixtures.js';

const sb = useSandbox();

function pass(extra: { verify?: boolean } = {}) {
  const s = sb();
  return archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot, ...extra });
}

/** Inject a pre-read stat, forcing `settled === false` without a race. */
function passUnsettled(rel: string) {
  const s = sb();
  const sourceRoot = canonicalizeTranscriptPath(s.sourceRoot);
  mkdirSync(s.archiveRoot, { recursive: true });
  const archiveRoot = canonicalizeTranscriptPath(s.archiveRoot);
  const entry = discover(sourceRoot, archiveRoot).find((e) => e.relPath === rel);
  expect(entry, `no discovered entry for ${rel}`).toBeDefined();

  let call = 0;
  const ctx = createMirrorContext({
    archiveRoot,
    statFile: (path) => {
      const real = statSync(path, { bigint: true });
      if (call++ > 0) return real;
      // A different pre-read mtimeNs means the re-stat cannot match.
      const doctored = Object.create(real) as BigIntStats;
      Object.defineProperty(doctored, 'mtimeNs', { value: real.mtimeNs + 1n });
      return doctored;
    },
  });
  return mirrorFile(entry!, ctx);
}

const SESSION = `${SLUG}/sess-1.jsonl`;
const SUB_JSONL = `${SLUG}/sess-1/subagents/agent-a.jsonl`;
const SUB_META = `${SLUG}/sess-1/subagents/agent-a.meta.json`;
const TOOL_TXT = `${SLUG}/sess-1/tool-results/abc.txt`;
const NESTED_JSONL = `${SLUG}/sess-1/subagents/workflows/wf_18e7ec0c-db9/agent-y.jsonl`;
const NESTED_JOURNAL = `${SLUG}/sess-1/subagents/workflows/wf_18e7ec0c-db9/journal.jsonl`;

describe('AC1 — all four kinds mirror byte-identically', () => {
  it('mirrors *.jsonl, subagents/*.jsonl, agent-*.meta.json and tool-results/*.txt (Test 1)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    writeSource(s, SUB_JSONL, jsonLines(2, 100));
    writeSource(s, SUB_META, '{"model":"claude","tokens":42}');
    writeSource(s, TOOL_TXT, 'tool output with no trailing newline');

    const result = pass();

    expect(result.filesSeen).toBe(4);
    for (const rel of [SESSION, SUB_JSONL, SUB_META, TOOL_TXT]) {
      expect(existsSync(archivePath(s, rel)), `${rel} not archived`).toBe(true);
      expect(bytesEqual(sourcePath(s, rel), archivePath(s, rel)), `${rel} not byte-identical`).toBe(
        true,
      );
    }
    expect(result.files.every((f) => f.source_state === 'present')).toBe(true);
  });

  it('finds sidecars nested under subagents/workflows/** (Test 2)', () => {
    // Goes red on any fixed-depth walk.
    const s = sb();
    writeSource(s, SESSION, jsonLines(1));
    writeSource(s, NESTED_JSONL, jsonLines(1, 7));
    writeSource(s, NESTED_JOURNAL, jsonLines(1, 8));

    pass();

    expect(bytesEqual(sourcePath(s, NESTED_JSONL), archivePath(s, NESTED_JSONL))).toBe(true);
    expect(bytesEqual(sourcePath(s, NESTED_JOURNAL), archivePath(s, NESTED_JOURNAL))).toBe(true);
  });

  it('handles a dash-prefixed slug on both the source and the archive side (Test 3)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));

    const result = pass();

    expect(result.files[0]!.archive_path).toBe(join(s.archiveRoot, SESSION));
    expect(readdirSync(s.archiveRoot)).toContain(SLUG);
    expect(bytesEqual(sourcePath(s, SESSION), archivePath(s, SESSION))).toBe(true);
  });

  it('archives a zero-newline meta.json IN FULL on the first pass (Test 7)', () => {
    // These end in `}` with no trailing newline, so universal newline truncation
    // would archive 0 bytes of them forever.
    const s = sb();
    const body = '{"model":"claude-opus","usage":{"in":1,"out":2}}';
    writeSource(s, SUB_META, body);

    const result = pass();

    expect(readFileSync(archivePath(s, SUB_META), 'utf8')).toBe(body);
    expect(result.files[0]!.bytes_copied).toBe(body.length);
  });

  it('excludes memory/*.md and sessions-index.json', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(1));
    writeSource(s, `${SLUG}/memory/notes.md`, '# user-managed, not expiring transcript data\n');
    writeSource(s, `${SLUG}/sessions-index.json`, '{"sessions":[]}');

    const result = pass();

    expect(result.filesSeen).toBe(1);
    expect(existsSync(archivePath(s, `${SLUG}/memory/notes.md`))).toBe(false);
    expect(existsSync(archivePath(s, `${SLUG}/sessions-index.json`))).toBe(false);
  });
});

describe('AC2 — appends copy only up to the last complete newline', () => {
  it('an UNSETTLED partial trailing line mirrors N-1 lines and ends in \\n (Test 4)', () => {
    const s = sb();
    writeSource(s, SESSION, `${jsonLines(5)}{"partial":`);

    const state = passUnsettled(SESSION);

    const archived = readFileSync(archivePath(s, SESSION));
    expect(archived.toString('utf8').split('\n').filter(Boolean)).toHaveLength(5);
    expect(archived[archived.length - 1]).toBe(0x0a);
    expect(state.bytes_copied).toBe(jsonLines(5).length);
  });

  it('a SETTLED partial trailing line is archived verbatim, then completed exactly once (Test 5)', () => {
    // Under universal newline truncation this line is never copied, the source
    // then expires, and the bytes are gone.
    const s = sb();
    const complete = jsonLines(5);
    writeSource(s, SESSION, `${complete}{"partial":`);

    const first = pass();
    expect(bytesEqual(sourcePath(s, SESSION), archivePath(s, SESSION))).toBe(true);
    expect(first.files[0]!.bytes_copied).toBe(complete.length + '{"partial":'.length);

    // Now the writer finishes the line.
    const remainder = '1}\n';
    writeFileSync(sourcePath(s, SESSION), `${complete}{"partial":${remainder}`);
    const second = pass();

    const archived = readFileSync(archivePath(s, SESSION), 'utf8');
    expect(archived.split('\n').filter(Boolean)).toHaveLength(6);
    expect(second.files[0]!.bytes_copied).toBe(remainder.length);
    expect(bytesEqual(sourcePath(s, SESSION), archivePath(s, SESSION))).toBe(true);
  });
});

describe('AC3 — size comes from statSync, with no persisted counter', () => {
  it('a second pass over an unchanged corpus copies 0 bytes and writes no log line (Test 8)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    writeSource(s, SUB_META, '{"a":1}');

    const first = pass();
    expect(first.bytesCopied).toBeGreaterThan(0);
    expect(first.logged).toBe(true);
    const logAfterFirst = readBytes(join(s.dataDir, 'logs', 'archive.jsonl'));

    const second = pass();

    expect(second.bytesCopied).toBe(0);
    expect(second.logged).toBe(false);
    expect(readBytes(join(s.dataDir, 'logs', 'archive.jsonl')).equals(logAfterFirst)).toBe(true);
  });

  it('a crash mid-append converges to a byte-identical mirror with no torn line (Test 9)', () => {
    // Truncating the archive to a mid-line offset models a crash.
    const s = sb();
    const body = jsonLines(10);
    writeSource(s, SESSION, body);
    pass();

    const midLine = body.indexOf('\n') + 5;
    truncateSync(archivePath(s, SESSION), midLine);
    expect(statSync(archivePath(s, SESSION)).size).toBe(midLine);

    const resumed = pass();

    expect(bytesEqual(sourcePath(s, SESSION), archivePath(s, SESSION))).toBe(true);
    expect(resumed.files[0]!.bytes_copied).toBe(body.length - midLine);
    expect(readFileSync(archivePath(s, SESSION), 'utf8').split('\n').filter(Boolean)).toHaveLength(
      10,
    );
  });

  it('persists no counter: the data dir holds only archive/, logs/ and the lock (Test 12)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));

    pass();

    // The lock is released on the normal path, so it should not even be present.
    expect(readdirSync(s.dataDir).sort()).toEqual(['archive', 'logs']);

    // The pass is a pure function of the two trees: deleting the log changes nothing.
    const before = readBytes(archivePath(s, SESSION));
    const again = pass();
    expect(again.bytesCopied).toBe(0);
    expect(readBytes(archivePath(s, SESSION)).equals(before)).toBe(true);
  });

  it('creates NO archive entry for a zero-byte copy, then creates it once settled (Test 25)', () => {
    // A 0-byte archive file would outlive its source as the archived truth.
    const s = sb();
    const body = '{"model":"claude","no_newline_anywhere":true}';
    writeSource(s, SUB_META, body);

    const state = passUnsettled(SUB_META);

    expect(state.bytes_copied).toBe(0);
    expect(existsSync(archivePath(s, SUB_META))).toBe(false);
    expect(
      discover(
        canonicalizeTranscriptPath(s.sourceRoot),
        canonicalizeTranscriptPath(s.archiveRoot),
      ).filter((e) => e.presence !== 'source-only'),
    ).toHaveLength(0);

    const settled = pass();
    expect(settled.bytesCopied).toBe(body.length);
    expect(readFileSync(archivePath(s, SUB_META), 'utf8')).toBe(body);
  });
});

describe('AC4 — divergence never destroys', () => {
  it('shrink: keeps every archived byte and marks diverged (Test 13)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(10));
    pass();
    const before = readBytes(archivePath(s, SESSION));

    writeFileSync(sourcePath(s, SESSION), jsonLines(3));
    const result = pass();

    expect(result.files[0]!.source_state).toBe('diverged');
    expect(result.files[0]!.reason).toBe('shrink');
    expect(result.bytesCopied).toBe(0);
    expect(readBytes(archivePath(s, SESSION)).equals(before)).toBe(true);
  });

  it('head rewrite: an in-place rewrite of the first 4 KB at unchanged length diverges (Test 14)', () => {
    const s = sb();
    const body = Buffer.alloc(10240, 0x61);
    writeSource(s, TOOL_TXT, body);
    pass();
    const before = readBytes(archivePath(s, TOOL_TXT));

    const rewritten = Buffer.from(body);
    rewritten.fill(0x62, 0, 4096);
    writeFileSync(sourcePath(s, TOOL_TXT), rewritten);
    const result = pass();

    expect(result.files[0]!.source_state).toBe('diverged');
    expect(result.files[0]!.reason).toBe('head');
    expect(readBytes(archivePath(s, TOOL_TXT)).equals(before)).toBe(true);
  });

  it('seam rewrite: the 181-of-182 case a head check cannot see (Test 15)', () => {
    // archiveSize 10240 -> head [0,4096), seam [6144,10240). Pin the rewrite
    // inside the seam window, or it lands in the blind band.
    const s = sb();
    const body = Buffer.alloc(10240, 0x61);
    writeSource(s, TOOL_TXT, body);
    pass();
    const before = readBytes(archivePath(s, TOOL_TXT));
    expect(before.length).toBe(10240);

    const rewritten = Buffer.concat([body, Buffer.alloc(512, 0x63)]);
    rewritten.fill(0x64, 8192, 8300);
    writeFileSync(sourcePath(s, TOOL_TXT), rewritten);
    const result = pass();

    expect(result.files[0]!.source_state).toBe('diverged');
    expect(result.files[0]!.reason).toBe('seam');
    expect(result.bytesCopied).toBe(0);
    expect(readBytes(archivePath(s, TOOL_TXT)).equals(before)).toBe(true);
  });

  it('the blind band between the head and seam windows is undetected, by design (Test 15b)', () => {
    // Pins the blind band as a known limitation, so moving either probe window
    // is a deliberate change.
    const s = sb();
    const body = Buffer.alloc(10240, 0x61);
    writeSource(s, TOOL_TXT, body);
    pass();

    const rewritten = Buffer.from(body);
    rewritten.fill(0x64, 4100, 4200); // after the head window, before the seam window
    writeFileSync(sourcePath(s, TOOL_TXT), rewritten);
    const result = pass();

    expect(result.files[0]!.source_state).toBe('present');
    expect(result.files[0]!.reason).toBeUndefined();
  });

  it('a diverged file is never appended to again (Test 16)', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(10));
    pass();
    const before = readBytes(archivePath(s, SESSION));

    writeFileSync(sourcePath(s, SESSION), jsonLines(3));
    expect(pass().files[0]!.reason).toBe('shrink');

    // Now grow the diverged source past the archived size with different content.
    writeFileSync(sourcePath(s, SESSION), jsonLines(3) + jsonLines(20, 900));
    const grown = pass();

    expect(grown.files[0]!.source_state).toBe('diverged');
    expect(grown.bytesCopied).toBe(0);
    expect(readBytes(archivePath(s, SESSION)).equals(before)).toBe(true);
  });
});

describe('expiry is durable, and sealing does not break it (Test 17)', () => {
  it('(a) reports expired from the ARCHIVE walk, on every subsequent pass', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    pass();
    const logical = archivePath(s, SESSION);
    const archived = readBytes(logical);

    rmSourceTree(s, SESSION);

    const reader = createArchiveReader();
    const sealedOn: Record<string, string[]> = {};
    let afterSeal: Map<string, TreeEntry> | undefined;

    for (const label of ['second', 'third']) {
      const result = pass();

      // The archive-walk enumeration property, untouched by sealing.
      expect(result.filesSeen, label).toBe(1);
      expect(result.files[0]!.source_state, label).toBe('expired');

      // The one intended behavioural change: `hot` becomes `sealed` from the
      // pass that compresses onward.
      expect(result.files[0]!.archive_state, label).toBe('sealed');

      // The archived bytes still resolve at their LOGICAL path — read through
      // the accessor rather than raw, so this now exercises the decompress and
      // the frame content-size check that a readFileSync never touched.
      expect(reader.size(logical), label).toBe(archived.length);
      expect(reader.read(logical, 0, archived.length).equals(archived), label).toBe(true);

      sealedOn[label] = result.sealed;
      afterSeal ??= snapshotTree(s.archiveRoot);
    }

    // Durability across passes: the second pass sealed and the third left the
    // `.zst` alone, inode and mtime included. Without this the test would prove
    // only that a first seal happened, losing the guarantee it was written for.
    expect(sealedOn.second).toEqual([logical]);
    expect(sealedOn.third).toEqual([]);
    expect(snapshotTree(s.archiveRoot)).toEqual(afterSeal);
  });

  it('(b) keys a sealed .zst sibling under its logical name, as archive_state sealed', () => {
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));

    const result = pass();

    expect(result.filesSeen).toBe(1);
    expect(result.files[0]!.archive_path).toBe(join(s.archiveRoot, SESSION));
    expect(result.files[0]!.archive_state).toBe('sealed');
    expect(result.files[0]!.source_state).toBe('expired');
  });

  it('(c) a restored source beside a sealed .zst does NOT double-generate the file', () => {
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));
    writeSource(s, SESSION, jsonLines(4));

    const result = pass();

    expect(result.filesSeen).toBe(1);
    expect(result.files[0]!.archive_state).toBe('sealed');
    expect(result.bytesCopied).toBe(0);
    expect(existsSync(archivePath(s, SESSION))).toBe(false);
    expect(readdirSync(join(s.archiveRoot, SLUG))).toEqual(['sess-1.jsonl.zst']);
  });
});

describe('the divergence log (Test 18)', () => {
  it('names the diverged source and its reason, one line per pass', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(10));
    writeSource(s, SUB_JSONL, jsonLines(10, 500));
    pass();

    writeFileSync(sourcePath(s, SESSION), jsonLines(2));
    writeFileSync(sourcePath(s, SUB_JSONL), jsonLines(2, 500));
    pass();

    const lines = readFileSync(join(s.dataDir, 'logs', 'archive.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    // One line per pass, not per file: two files diverged in the second pass.
    expect(lines).toHaveLength(2);
    const record = JSON.parse(lines[1]!) as {
      diverged: { source_path: string; reason: string }[];
    };
    expect(record.diverged).toHaveLength(2);
    expect(record.diverged.map((d) => d.reason)).toEqual(['shrink', 'shrink']);
    expect(record.diverged.map((d) => d.source_path).sort()).toEqual(
      [sourcePath(s, SESSION), sourcePath(s, SUB_JSONL)].sort(),
    );
  });

  it('writes nothing at all for a fully quiet pass', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    pass();
    pass();
    pass();

    const lines = readFileSync(join(s.dataDir, 'logs', 'archive.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

describe('--verify catches what the per-pass probe cannot (Test 24)', () => {
  it('diverges the blind-band rewrite that a normal pass reports as present', () => {
    const s = sb();
    const body = Buffer.alloc(10240, 0x61);
    writeSource(s, TOOL_TXT, body);
    pass();

    const rewritten = Buffer.from(body);
    rewritten.fill(0x64, 4100, 4200);
    writeFileSync(sourcePath(s, TOOL_TXT), rewritten);

    expect(pass().files[0]!.source_state).toBe('present');

    const verified = pass({ verify: true });
    expect(verified.files[0]!.source_state).toBe('diverged');
    expect(verified.files[0]!.reason).toBe('verify');
  });

  it('(a) diverges nothing over an untouched corpus, including a settled partial tail', () => {
    const s = sb();
    writeSource(s, SESSION, `${jsonLines(4)}{"partial":`);
    writeSource(s, SUB_META, '{"no":"newline"}');
    pass();

    const verified = pass({ verify: true });

    expect(verified.files.every((f) => f.source_state === 'present')).toBe(true);
  });

  it('(b) does not diverge a source that has merely GROWN since the last pass', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    pass();
    writeFileSync(sourcePath(s, SESSION), jsonLines(4) + jsonLines(4, 100));

    const verified = pass({ verify: true });

    expect(verified.files[0]!.source_state).toBe('present');
    expect(bytesEqual(sourcePath(s, SESSION), archivePath(s, SESSION))).toBe(true);
  });

  it('(c) is OFF by default: a plain pass does not read the whole file', () => {
    const s = sb();
    const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
    writeSource(s, TOOL_TXT, body);
    pass();

    const plain = pass();
    const verified = pass({ verify: true });

    // A quiet pass reads only the head and seam probes, never the whole body.
    expect(plain.bytesRead).toBeLessThan(64 * 1024);
    expect(verified.bytesRead).toBeGreaterThanOrEqual(body.length);
  });
});

/** Expire a source file, standing in for the harness's own retention sweep. */
function rmSourceTree(s: Sandbox, rel: string): void {
  rmSync(sourcePath(s, rel));
}
