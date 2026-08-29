// Three guards: 19, that the transcript root is never written to; 20, that the
// binary cron runs never loads `node:sqlite`, transitively; and 21, that a
// symlink planted at an archive leaf is refused rather than followed.

import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { archiveOnce } from '../mirror.js';
// Through the package's own export surface on purpose: AC3's reachable case is a
// caller that never realpaths the archive root, which only the exports allow.
import { createMirrorContext, discover, mirrorFile } from '../index.js';
import type { ArchiveLogRecord } from '../log.js';
import {
  cleanup,
  DECOYS,
  decoyPath,
  jsonLines,
  makeSandbox,
  plantArchiveSymlink,
  plantDataDirSymlink,
  plantDirSymlink,
  SLUG,
  snapshotTree,
  snapshotTreeSafe,
  sourcePath,
  writeSource,
  type Sandbox,
} from './fixtures.js';

const REPO = resolve(import.meta.dirname, '../../..');
const BIN = join(REPO, 'bin', 'agent-lens.js');
const ARCHIVE_SRC = join(REPO, 'src', 'archive');

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) {
    restorePermissions(sandbox.sourceRoot);
    cleanup(sandbox);
  }
  sandbox = undefined;
});

/** Dirs 0500, files 0400, bottom-up. */
function lockDown(dir: string): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) lockDown(path);
    else chmodSync(path, 0o400);
  }
  chmodSync(dir, 0o500);
}

/** Undo `lockDown`, or the temp-dir teardown itself fails with EACCES. */
function restorePermissions(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    chmodSync(dir, 0o700);
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) restorePermissions(path);
      else chmodSync(path, 0o600);
    }
  } catch {
    // Best effort — teardown must not mask the real assertion failure.
  }
}

const SESSION = `${SLUG}/sess-1.jsonl`;
const VICTIM = `${SLUG}/victim.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;
const META = `${SLUG}/sess-1/subagents/agent-a.meta.json`;
const PARTIAL = `${SLUG}/sess-3.jsonl`;

/** All five scenarios in one corpus, so one pass exercises every branch. */
function buildMixedCorpus(s: Sandbox): void {
  writeSource(s, SESSION, jsonLines(6));
  writeSource(s, OTHER, jsonLines(6, 200));
  writeSource(s, META, '{"model":"claude"}');
  writeSource(s, PARTIAL, `${jsonLines(3, 400)}{"partial":`);

  // Archive everything once, then manufacture the other four states.
  archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

  writeFileSync(sourcePath(s, OTHER), jsonLines(1, 200)); // -> diverged (shrink)
  rmSync(sourcePath(s, META)); // -> expired
  writeSource(s, PARTIAL, `${jsonLines(3, 400)}{"partial":1}\n`); // -> settled partial, completed
  truncateSync(join(s.archiveRoot, SESSION), 12); // -> crash resume
}

describe('the archive never writes to ~/.claude/projects (Test 19)', () => {
  it('leaves every source entry byte-, stat- and mode-identical across all five scenarios', () => {
    const s = sb();
    buildMixedCorpus(s);

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    // Assert the pass genuinely visited all five states, or the snapshot proves nothing.
    const states = result.files.map((f) => f.source_state);
    expect(states).toContain('diverged');
    expect(states).toContain('expired');
    expect(states).toContain('present');
    expect(result.bytesCopied).toBeGreaterThan(0);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) {
      expect(after.get(rel), rel).toEqual(entry);
    }
  });

  it('succeeds and copies the expected bytes with the source tree recursively read-only', () => {
    const s = sb();
    const body = jsonLines(8);
    writeSource(s, SESSION, body);
    writeSource(s, META, '{"model":"claude"}');
    // Locking only `root` protects nothing: in-scope files are levels deeper.
    lockDown(s.sourceRoot);

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    expect(result.errors).toEqual([]);
    expect(result.bytesCopied).toBe(body.length + '{"model":"claude"}'.length);
    expect(readFileSync(join(s.archiveRoot, SESSION), 'utf8')).toBe(body);
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
  });

  it('an accidental write into the locked-down source tree really would throw', () => {
    // Positive control: otherwise "the pass succeeded" could mean the chmod
    // protected nothing.
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    lockDown(s.sourceRoot);

    expect(() => writeFileSync(sourcePath(s, SESSION), 'nope')).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(dirname(sourcePath(s, SESSION)), 'new.jsonl'), 'x')).toThrow(
      /EACCES|EPERM/,
    );
  });
});

// --- Test 21: the archive never follows a symlinked leaf (task 1.4) ------

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDWR, O_WRONLY } = constants;

/** The one message every refusal must produce, whichever errno the kernel used. */
const REFUSED = /refusing to follow a symlinked archive destination/;

/** The other refusal: containment, not leaf-following. */
const OUTSIDE = /refusing to write outside the archive root/;

function readArchiveLog(s: Sandbox): ArchiveLogRecord[] {
  const path = join(s.dataDir, 'logs', 'archive.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ArchiveLogRecord);
}

describe('the archive refuses a symlinked leaf (Test 21)', () => {
  it('(1) refuses a leaf symlink aimed into the transcript root, leaving the victim intact', () => {
    // The reproduction from the task's Why, committed. Pre-fix this pass returned
    // `errors: []`, copied 32 bytes, and appended `{"c":3}` to the victim.
    const s = sb();
    writeSource(s, SESSION, '{"a":1}\n{"b":2}\n{"c":3}\n');
    // A byte-PREFIX of the source on purpose: a non-prefix victim short-circuits
    // `detectDivergence` to 'head', so nothing is written and the repro looks
    // safe for the wrong reason. Case (3) below covers that path instead.
    const victim = writeSource(s, VICTIM, '{"a":1}\n{"b":2}\n');
    const link = plantArchiveSymlink(s, SESSION, victim);

    const victimBytes = readFileSync(victim);
    const before = snapshotTree(s.sourceRoot);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    // (a) The load-bearing assertion: the victim's own bytes. Nothing about this
    // can pass vacuously — a followed symlink changes them.
    expect(readFileSync(victim)).toEqual(victimBytes);

    // (b) …and nothing else in the transcript root moved either.
    const after = snapshotTree(s.sourceRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);

    // (c) Reported through archiveOnce's error channel, naming the archive leaf.
    // `errors[].path` is the SOURCE path (mirror.ts), so the message is the only
    // place the planted link can be named.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.errors[0]?.message).toContain(link);

    // (d) Non-vacuity: one refusal did not abort the pass. victim.jsonl is itself
    // a source file, and its own legitimate archive copy is still written.
    expect(readFileSync(join(s.archiveRoot, VICTIM))).toEqual(victimBytes);
  });

  it('(2) refuses a leaf symlink aimed at a harmless EMPTY decoy under <dataDir>', () => {
    // The guard is "do not follow a final symlink", not "do not follow one that
    // lands somewhere I recognise". An empty target also means `archiveSize === 0`,
    // which skips the divergence block — so this exercises the WRITE open.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const decoy = decoyPath(s, 'empty.bin');
    writeFileSync(decoy, '');
    plantArchiveSymlink(s, SESSION, decoy);

    const before = snapshotTreeSafe(join(s.dataDir, DECOYS));
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(join(s.dataDir, DECOYS));

    expect(readFileSync(decoy)).toHaveLength(0); // pre-fix: receives `body`
    expect(after).toEqual(before); // covers ino, mtimeNs, size, mode
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.bytesCopied).toBe(0);
  });

  it('(3) refuses a leaf symlink aimed at a NON-PREFIX decoy, fabricating no diverged row', () => {
    // The silent second mode: pre-fix the divergence read followed the link, saw a
    // mismatched head, and archiveOnce reported `errors: []` plus a `diverged` row
    // — reason 'head', archive_size 18 — about a file the archive never wrote.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const decoy = decoyPath(s, 'nonprefix.bin');
    writeFileSync(decoy, '{"not":"a prefix"}');
    plantArchiveSymlink(s, SESSION, decoy);

    const before = snapshotTreeSafe(join(s.dataDir, DECOYS));
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(join(s.dataDir, DECOYS));

    expect(readFileSync(decoy, 'utf8')).toBe('{"not":"a prefix"}');
    expect(after).toEqual(before);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.files.map((f) => f.source_state)).not.toContain('diverged');

    // Asserted on the LOG, not only on the result: the fabricated row was durable.
    const logged = readArchiveLog(s);
    expect(logged.flatMap((r) => r.diverged)).toEqual([]);
    expect(logged.flatMap((r) => r.errors.map((e) => e.message))).toContainEqual(
      expect.stringMatching(REFUSED),
    );
  });

  it('(4) refuses a DANGLING leaf symlink, and names it instead of reporting a bare EEXIST', () => {
    // Already refused pre-fix — `statSafe` throws, so the create branch runs and
    // O_CREAT|O_EXCL returns EEXIST for a dangling link too. The delta here is the
    // message, not the safety: an unexplained EEXIST reads as a benign collision.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const nowhere = decoyPath(s, 'nowhere.bin');
    plantArchiveSymlink(s, SESSION, nowhere);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(existsSync(nowhere)).toBe(false); // nothing created through the link
    expect(result.bytesCopied).toBe(0);
  });

  it('(5) platform control — O_EXCL and O_NOFOLLOW are what refuse, and EEXIST is ambiguous', () => {
    // Asserted rather than assumed, per AC2, and the justification for mapping
    // EEXIST only after a post-hoc lstat. Uses openSync directly: test files are
    // excluded from the write-site scan (fs-write-sites.test.ts), so no site is added.
    const s = sb();
    const dir = join(s.root, 'probe');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'target');
    writeFileSync(target, 'target\n');
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'plain\n');
    const liveLink = join(dir, 'live-link');
    symlinkSync(target, liveLink);
    const danglingLink = join(dir, 'dangling-link');
    symlinkSync(join(dir, 'nowhere'), danglingLink);

    // The create path is already safe: O_CREAT|O_EXCL refuses a final symlink by
    // POSIX rule, live or dangling. 'wx' is that pair, so it holds today too.
    expect(() => openSync(liveLink, 'wx', 0o600)).toThrow(/EEXIST/);
    expect(() => openSync(danglingLink, 'wx', 0o600)).toThrow(/EEXIST/);
    expect(() => openSync(liveLink, O_WRONLY | O_CREAT | O_EXCL, 0o600)).toThrow(/EEXIST/);

    // …but EEXIST is NOT symlink-specific, so mapping it unconditionally would be a
    // false accusation. Reaching this branch from archiveOnce needs a genuine race
    // — a plain file present before the pass is seen by statSafe and takes the r+
    // branch — so it is pinned here at the kernel level rather than claimed above.
    expect(() => openSync(plain, O_WRONLY | O_CREAT | O_EXCL, 0o600)).toThrow(/EEXIST/);

    // The r+ branch is the one that needed changing, and O_NOFOLLOW is what changed it.
    expect(() => openSync(liveLink, O_RDWR | O_NOFOLLOW)).toThrow(/ELOOP/);
    closeSync(openSync(liveLink, O_RDWR)); // negative control: nothing ambient refuses

    // The log append (paths.ts, task 1.5) is the same rule with O_APPEND added.
    // O_CREAT without O_EXCL does NOT rescue a dangling link from O_NOFOLLOW, so
    // both forms are asserted rather than one assumed from the other.
    const APPEND = O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW;
    expect(() => openSync(liveLink, APPEND, 0o600)).toThrow(/ELOOP/);
    expect(() => openSync(danglingLink, APPEND, 0o600)).toThrow(/ELOOP/);
    // Negative control: without O_NOFOLLOW the very same open follows the link.
    closeSync(openSync(liveLink, O_WRONLY | O_CREAT | O_APPEND, 0o600));
  });
});

// --- Test 26: the log leaf and the directory chain (task 1.5) -------------
// 26, not 22: `mirror.property.test.ts` already uses 22 for the convergence
// property, and these numbers name requirements, not files.

const LOG_REL = join('logs', 'archive.jsonl');

/** Plants a symlink at `<dataDir>/logs/archive.jsonl`, the archive's own log leaf. */
function plantLogSymlink(s: Sandbox, target: string): string {
  const link = join(s.dataDir, LOG_REL);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return link;
}

describe('the archive refuses a symlinked log leaf and directory component (Test 26)', () => {
  it('(A1) refuses a log symlink aimed into the transcript root, leaving the victim intact', () => {
    // Pre-fix `appendFileSync` followed the link: the victim grew by one JSONL
    // line and `chmodSync` set its mode to 0600 through the link as well.
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    const victim = writeSource(s, VICTIM, jsonLines(2, 900));
    plantLogSymlink(s, victim);

    const victimBytes = readFileSync(victim);
    const before = snapshotTree(s.sourceRoot);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    // Non-quiet, so the pass genuinely reached the log write. Without this the
    // victim being untouched could just mean nothing was ever logged.
    expect(result.bytesCopied).toBeGreaterThan(0);

    expect(readFileSync(victim)).toEqual(victimBytes);
    const after = snapshotTree(s.sourceRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
  });

  it('(A2) refuses a log symlink aimed at a harmless decoy under <dataDir>', () => {
    // The rule is "do not follow a final symlink", not "do not follow one that
    // lands somewhere I recognise".
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    const decoy = decoyPath(s, 'log-decoy.bin');
    writeFileSync(decoy, 'DECOY\n');
    plantLogSymlink(s, decoy);

    const before = snapshotTreeSafe(join(s.dataDir, DECOYS));
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(join(s.dataDir, DECOYS));

    expect(readFileSync(decoy, 'utf8')).toBe('DECOY\n');
    expect(after).toEqual(before); // covers ino, mtimeNs, size, mode
    expect(result.logged).toBe(false);
  });

  it('(A3) names the log refusal in result.errors, returns rather than throws, and keeps the mirrored bytes', () => {
    const s = sb();
    const body = jsonLines(6);
    writeSource(s, SESSION, body);
    const decoy = decoyPath(s, 'log-decoy-2.bin');
    writeFileSync(decoy, '');
    const link = plantLogSymlink(s, decoy);

    // Limb one, and the pin on the CONTRACT CHANGE: `archiveOnce` returns a
    // result carrying the log failure. Were it to go back to throwing, this reds.
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    const logErrors = result.errors.filter((e) => e.path === link);
    expect(logErrors).toHaveLength(1);
    expect(logErrors[0]?.message).toMatch(REFUSED);
    expect(logErrors[0]?.message).toContain(link);
    expect(result.logged).toBe(false);

    // Limb two, the non-vacuity half: a hijacked event log must not cost the pass
    // the bytes it already mirrored. Satisfying limb one by aborting the pass is
    // precisely the outcome this limb exists to forbid.
    expect(readFileSync(join(s.archiveRoot, SESSION), 'utf8')).toBe(body);
    expect(result.bytesCopied).toBe(body.length);
  });

  it('(A4) positive control — with no symlink the log is a regular 0600 file holding the record', () => {
    // Without this, "no bytes reached the victim" could mean the log stopped
    // working altogether.
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toEqual([]);
    expect(result.logged).toBe(true);
    const stat = lstatSync(join(s.dataDir, LOG_REL));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    const records = readArchiveLog(s);
    expect(records).toHaveLength(1);
    expect(records[0]?.bytes_copied).toBeGreaterThan(0);
  });

  it('(B1) refuses a PRE-PLANTED symlinked directory component, creating nothing through it', () => {
    // The assertion that distinguishes pre- from post-fix is the ESCAPE TARGET's
    // own tree, not the message: pre-fix `ensureDir` ran before the containment
    // assert, so `sess-1/subagents` was created through the link and only then
    // was the write refused — the same refusal appears either way.
    //
    // "Pre-planted" is the whole claim. A link planted between the pre-assert and
    // the mkdir is NOT covered and cannot be — Node has no `mkdirat`.
    const s = sb();
    writeSource(s, META, '{"model":"claude"}');
    const escape = join(s.root, 'escape');
    plantDirSymlink(s, SLUG, escape);

    const before = snapshotTreeSafe(escape);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(escape);

    expect(after).toEqual(before);
    expect(after.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(OUTSIDE);
    expect(result.bytesCopied).toBe(0);
  });

  it('(B2) positive control — a real directory in the same place mirrors normally', () => {
    const s = sb();
    const body = '{"model":"claude"}';
    writeSource(s, META, body);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(s.archiveRoot, META), 'utf8')).toBe(body);
  });

  it('(B3) a DANGLING symlinked ancestor writes nothing either — but the kernel refuses it, not the guard', () => {
    // The honest limit of B1, pinned so the comment on `ensureDirUnder` cannot
    // drift into claiming more than it delivers. Green before task 1.5 as well —
    // it characterises a limit rather than proving a fix. `realpathSync` reports ENOENT
    // for a dangling link and for a component that was never created alike, so
    // `realpathDeepest` cannot tell them apart and the pre-assert lets this one
    // through. Nothing is written: recursive `mkdirSync` fails ENOENT on a
    // dangling component (measured, darwin/Node v26 — the draft approach claimed
    // EEXIST and a test written to that would have failed).
    const s = sb();
    writeSource(s, META, '{"model":"claude"}');
    const escapeParent = join(s.root, 'escape-parent');
    mkdirSync(escapeParent, { recursive: true });
    mkdirSync(s.archiveRoot, { recursive: true });
    const danglingTarget = join(escapeParent, 'nonexistent');
    symlinkSync(danglingTarget, join(s.archiveRoot, SLUG));

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    // The property that matters: nothing reached the escape target.
    expect(existsSync(danglingTarget)).toBe(false);
    expect(readdirSync(escapeParent)).toEqual([]);
    expect(result.bytesCopied).toBe(0);

    // …and the refusal is reported, but as the kernel's ENOENT rather than the
    // guard's containment message. Asserting ENOENT is the point: it records
    // WHICH layer stopped this, so a future change that moves the refusal into
    // the guard reds here and gets read rather than silently accepted.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/ENOENT/);
    expect(result.errors[0]?.message).not.toMatch(OUTSIDE);
  });

  it('(C1) FIX — an unresolved archiveRoot through the package exports mirrors instead of throwing', () => {
    // The one reachable form of the containment inconsistency, and the only limb
    // of AC3 that reds pre-fix. `archiveOnce` canonicalizes the root before the
    // assert ever sees it, so it already succeeds against this layout; a caller
    // reaching createMirrorContext/mirrorFile through the package's own exports
    // gets no such help and got `refusing to write outside the archive root`.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const volume = join(s.root, 'archive-volume');
    mkdirSync(volume, { recursive: true });
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(volume, s.archiveRoot);

    // Never realpathed — exactly what an external caller has in hand.
    const unresolvedRoot = s.archiveRoot;
    const entries = discover(s.sourceRoot, unresolvedRoot);
    expect(entries).toHaveLength(1);

    const state = mirrorFile(entries[0]!, createMirrorContext({ archiveRoot: unresolvedRoot }));

    expect(state.bytes_copied).toBe(body.length);
    expect(readFileSync(join(volume, SESSION), 'utf8')).toBe(body);
  });

  it('(C2) PIN, prospective and green before task 1.5 — AGENT_LENS_DIR at a symlinked archive root still mirrors', () => {
    // This is NOT evidence of a fix and must never be read as one: it passed
    // unmodified before this task. It exists so that the directory-chain refusal
    // above cannot be bought by refusing symlinked ROOTS too, which would break
    // relocating a "keep everything forever" archive onto another volume.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const volume = join(s.root, 'archive-volume');
    mkdirSync(volume, { recursive: true });
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(volume, s.archiveRoot);

    const previous = process.env.AGENT_LENS_DIR;
    process.env.AGENT_LENS_DIR = s.dataDir;
    let result;
    try {
      result = archiveOnce({ transcriptRoot: s.sourceRoot });
    } finally {
      if (previous === undefined) delete process.env.AGENT_LENS_DIR;
      else process.env.AGENT_LENS_DIR = previous;
    }

    expect(result.errors).toEqual([]);
    expect(result.archiveRoot).toBe(volume);
    expect(readFileSync(join(volume, SESSION), 'utf8')).toBe(body);
  });

  it('(C3) PIN, also green before task 1.5 — an interior symlink that stays INSIDE the real root is allowed', () => {
    // The third clause of the rule the guard now states in one place: the root
    // may be a link, an interior link may not escape the real root (B1), and one
    // that stays inside it is fine. This clause is what stops B1's refusal from
    // over-refusing; like C2 its value is entirely prospective.
    const s = sb();
    const body = '{"model":"claude"}';
    writeSource(s, META, body);
    const inside = join(s.archiveRoot, 'relocated');
    plantDirSymlink(s, SLUG, inside);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(inside, 'sess-1', 'subagents', 'agent-a.meta.json'), 'utf8')).toBe(
      body,
    );
  });
});

// --- Test 27: the three <dataDir>-level directory creations, and the last
// path-based mode change (task 1.7) ---------------------------------------
// 27 names the requirement, not the file, like 19/20/21/26 above.

/** The refusal the two `<dataDir>`-anchored callers produce. */
const OUTSIDE_DATA_DIR = /refusing to write outside the data dir/;

/** The refusal that keeps the archive's own writes out of the corpus. */
const INSIDE_SOURCE_ROOT = /refusing to write inside the transcript root/;

describe('the archive contains its own <dataDir>-level writes (Test 27)', () => {
  it('(A1) the create-branch mode change is fd-based — 0600 survives a masking umask', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));

    // 0o400 masks the owner READ bit. NOT 0o200: `makeSandbox` leaves <dataDir>
    // unmade, so the first ensureDir would create it at 0o700 & ~0o200 = 0o500 and
    // the recursive mkdir of `archive` inside a non-writable directory fails
    // EACCES. 0o077 would distinguish nothing — 0600 has no group/other bits.
    // Vitest's default `forks` pool gives this file its own process and runs its
    // tests sequentially, so the umask cannot leak into another file.
    const previous = process.umask(0o400);
    try {
      const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

      expect(result.errors).toEqual([]);
      // `lstatSync` only: the directories the umask created land 0o300, so nothing
      // here may readdir that sandbox.
      const stat = lstatSync(join(s.archiveRoot, SESSION));
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      // Every directory the umask created, not just the two on the archive path:
      // 0o300 is write+exec but NOT readable, so the shared afterEach's recursive
      // rmSync fails ENOTEMPTY without this and lands as its own failing test.
      restorePermissions(s.dataDir);
    }
  });

  it('(A2) positive control — the create open ALONE leaves 0200 under that umask', () => {
    // What makes A1 non-vacuous: with the mode change deleted the archive file
    // lands 0200 (0o600 & ~0o400), so removing it reds A1 while this stays green.
    // Uses openSync directly — test files are excluded from the write-site scan
    // (fs-write-sites.test.ts), so no manifest site is added.
    const s = sb();
    const probe = join(s.root, 'probe-mode');
    mkdirSync(probe, { recursive: true });
    const raw = join(probe, 'raw.bin');

    const previous = process.umask(0o400);
    try {
      closeSync(openSync(raw, O_WRONLY | O_CREAT | O_EXCL, 0o600));
      expect(lstatSync(raw).mode & 0o777).toBe(0o200);
    } finally {
      process.umask(previous);
      restorePermissions(probe);
    }
  });

  it('(C1) refuses a PRE-PLANTED <dataDir>/logs symlink that escapes the data dir', () => {
    // Pre-fix `ensureDir` followed the link and the O_NOFOLLOW open then created
    // `archive.jsonl` INSIDE the escape target — measured, after.size === 1. The
    // escape target's own tree is what distinguishes pre- from post-fix here,
    // exactly as in (B1) above.
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    const escape = join(s.root, 'escape-logs');
    mkdirSync(escape, { recursive: true });
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(escape, join(s.dataDir, 'logs'));

    const before = snapshotTreeSafe(escape);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(escape);

    expect(after).toEqual(before);
    expect(after.size).toBe(0);
    expect(result.logged).toBe(false);

    const logErrors = result.errors.filter((e) => e.path === join(s.dataDir, LOG_REL));
    expect(logErrors).toHaveLength(1);
    expect(logErrors[0]?.message).toMatch(OUTSIDE_DATA_DIR);

    // Non-vacuity, and the same rule (A3) pins: a refused log must not cost the
    // pass the bytes it already mirrored.
    expect(result.bytesCopied).toBeGreaterThan(0);
  });

  it('(C2) refuses a PRE-PLANTED escaping <dataDir>/archive.lock rather than reading the victim', () => {
    // The delta this caller has is a READ, not a write, and the test is written to
    // that. MEASURED pre-fix: the pass returned
    // {"state":"held","holder_pid":<live pid>,"age_ms":12345} — the victim's own
    // planted record decided the verdict — while the escape target's tree was
    // unchanged and the victim's bytes intact, because 'wx' refuses to write
    // through the link and `unlinkSync` removes the link rather than the target.
    // An escape-target snapshot here would therefore be GREEN BEFORE THE FIX,
    // which is the vacuity (B1)'s comment forbids; the lock verdict is the only
    // limb that genuinely distinguishes pre from post.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    mkdirSync(s.dataDir, { recursive: true });
    const victim = join(s.root, 'victim.lock');
    // A LIVE pid on THIS host, or rows 3/4 reclaim the lock and unlink instead of
    // reporting `held`, and the pre-fix verdict this asserts against never occurs.
    writeFileSync(
      victim,
      JSON.stringify({ pid: process.pid, started_at: Date.now() - 12345, hostname: osHostname() }),
    );
    const victimBytes = readFileSync(victim);
    symlinkSync(victim, join(s.dataDir, 'archive.lock'));

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.lock.state).not.toBe('held');
    expect(result.lock.holder_pid).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(OUTSIDE_DATA_DIR);
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.bytesCopied).toBe(0);

    // Secondary, and deliberately NOT the distinguishing limb: this property
    // already held pre-fix. Labelled so no later reader promotes it.
    expect(readFileSync(victim)).toEqual(victimBytes);
  });

  it('(C3) refuses a <dataDir> that resolves INSIDE the transcript root', () => {
    // MEASURED on main, and it needs no symlink at all: `--dataDir <path inside
    // the corpus>` returned `errors: []` and created lens-data/archive/… AND
    // lens-data/logs/archive.jsonl inside ~/.claude/projects. Test 19's read-only
    // guarantee over the corpus was defeated by a plain flag value.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const inside = join(s.sourceRoot, 'lens-data');

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: inside, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
    expect(existsSync(inside)).toBe(false);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(INSIDE_SOURCE_ROOT);
    // 1.9's discriminator: an archive-side refusal exits 3, never 0.
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.bytesCopied).toBe(0);
    expect(result.logged).toBe(false);
  });

  it('(C4) refuses a <dataDir>/archive symlinked INTO the transcript root', () => {
    // Neither anchor subsumes the other, which is why both exist: (C3)'s data-dir
    // anchor passes here — <dataDir> is a sibling of the corpus — and the
    // archive-root anchor passes in (C3), where <dataDir>/archive is an ordinary
    // child. MEASURED on main: errors=[], 16 bytes, and
    // `stolen/-Users-dev-proj/sess-1.jsonl` created inside the corpus.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const stolen = join(s.sourceRoot, 'stolen');
    mkdirSync(stolen, { recursive: true });
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(stolen, s.archiveRoot);

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
    expect(readdirSync(stolen)).toEqual([]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(INSIDE_SOURCE_ROOT);
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.bytesCopied).toBe(0);
  });

  it('(C5) refuses a <dataDir> inside the corpus even when its archive escapes outward', () => {
    // The limb that pins the DATA-DIR anchor specifically, and the reason it is
    // not redundant with (C3)/(C4): with <dataDir>/archive symlinked OUT of the
    // corpus the archive-root anchor is satisfied — the bytes really do land on
    // the other volume — while the log and the lock, which sit beside the archive
    // rather than inside it, are still created in ~/.claude/projects. MEASURED:
    // deleting the data-dir assert alone reds nothing WITHOUT this test, and
    // leaves lens-data/logs/archive.jsonl and lens-data/archive.lock in the
    // corpus. One anchor per escape route, each with the test that proves it.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const inside = join(s.sourceRoot, 'lens-data');
    const volume = join(s.root, 'archive-volume');
    mkdirSync(volume, { recursive: true });
    mkdirSync(inside, { recursive: true });
    symlinkSync(volume, join(inside, 'archive'));

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: inside, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    // Nothing new inside the corpus: no logs/, no archive.lock, nothing.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
    expect(readdirSync(volume)).toEqual([]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(INSIDE_SOURCE_ROOT);
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.lock.state).toBe('not-attempted');
    expect(result.bytesCopied).toBe(0);
    expect(result.logged).toBe(false);
  });

  it('(D1) counterweight — a symlinked <dataDir> still mirrors normally', () => {
    // Relocating the whole store onto another volume is a supported layout, and
    // the counterweight that stops (C1)-(C4) from being bought with a blanket
    // symlink refusal. Never previously committed as a fixture — only measured.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const real = plantDataDirSymlink(s, join(s.root, 'real-data'));

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toEqual([]);
    expect(result.archiveRoot).toBe(join(real, 'archive'));
    expect(readFileSync(join(real, 'archive', SESSION), 'utf8')).toBe(body);
    expect(result.logged).toBe(true);
  });

  it('(D2) counterweight — a symlinked <dataDir>/archive still mirrors normally', () => {
    // Duplicates Test 26's (C2) pin on purpose, so the counterweight is legible
    // from inside Test 27 too: a blanket symlink refusal reds D1, D2 and Test 26's
    // (C2)/(C3) at once, the fastest available signal that this guard over-refused.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const volume = join(s.root, 'archive-volume');
    mkdirSync(volume, { recursive: true });
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(volume, s.archiveRoot);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(volume, SESSION), 'utf8')).toBe(body);
  });

  it('(E) every guarded site records the concurrent-plant window as PERMANENT', () => {
    // AC5, characterised rather than claimed, and read off the NEW sites too: the
    // sentence on `ensureDirUnder` alone would let the archiveOnce and acquireLock
    // guards ship with no statement of their limit at all. The `why`-string half
    // of AC5 is asserted in fs-write-sites.test.ts, where WRITE_SITES is in scope.
    const PERMANENCE = /openat|mkdirat|dirfd/;
    for (const file of ['paths.ts', 'mirror.ts', 'lock.ts']) {
      expect(readFileSync(join(ARCHIVE_SRC, file), 'utf8'), file).toMatch(PERMANENCE);
    }
  });
});

// --- Test 20: the import graph -------------------------------------------

/** The probe runs in every node process the binary spawns. */
function writeProbe(dir: string): string {
  const path = join(dir, 'module-probe.mjs');
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const out = process.env.AGENT_LENS_MODULE_PROBE_OUT;',
      'if (out) {',
      "  process.on('exit', () => {",
      '    try {',
      '      writeFileSync(join(out, `probe-${process.pid}.json`), JSON.stringify(process.moduleLoadList));',
      '    } catch {}',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  return path;
}

function probedRun(
  args: string[],
  probePath: string,
  outDir: string,
): Promise<{ status: number | null; modules: string[][] }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: {
        ...process.env,
        AGENT_LENS_MODULE_PROBE_OUT: outDir,
        NODE_OPTIONS: `--import file://${probePath}`,
      },
      stdio: 'ignore',
    });
    child.on('close', (status) => {
      const modules = readdirSync(outDir).map(
        (file) => JSON.parse(readFileSync(join(outDir, file), 'utf8')) as string[],
      );
      resolvePromise({ status, modules });
    });
  });
}

describe('agent-lens archive never loads node:sqlite (Test 20)', () => {
  it('(a) the SPAWNED BINARY — what cron actually runs — loads no sqlite module', async () => {
    // Probes the binary, not `src/archive/index.ts`: a guard on the archive
    // module alone stays green while the real entry point is dirty.
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    const probe = writeProbe(s.root);
    const outDir = join(s.root, 'probe-archive');
    mkdirSync(outDir, { recursive: true });

    const { status, modules } = await probedRun(
      [BIN, 'archive', '--dataDir', s.dataDir, '--transcriptRoot', s.sourceRoot],
      probe,
      outDir,
    );

    expect(status).toBe(0);
    expect(modules.length).toBeGreaterThan(0);
    // Non-vacuity: node:crypto is the marker that archive code really ran.
    expect(modules.some((list) => list.some((m) => /crypto/i.test(m)))).toBe(true);
    for (const list of modules) {
      expect(list.filter((m) => /sqlite/i.test(m))).toEqual([]);
    }
  }, 60000);

  it('(a-control) the same probe DOES report sqlite for a known-dirty entry point', async () => {
    // Without this, a probe that silently loaded nothing would pass vacuously.
    // Re-pointed from the deleted `db/index.ts` to `db/open.ts`, which is the
    // surviving `node:sqlite` loader and a WRITE_SITES carrier in its own right.
    const s = sb();
    const probe = writeProbe(s.root);
    const outDir = join(s.root, 'probe-control');
    mkdirSync(outDir, { recursive: true });

    const { modules } = await probedRun(
      ['--import', 'tsx', '-e', "import('./src/db/open.ts')"],
      probe,
      outDir,
    );

    expect(modules.some((list) => list.some((m) => /sqlite/i.test(m)))).toBe(true);
  }, 60000);

  it('(b) no file reachable from src/archive/index.ts lives under db/, server/ or capture/', () => {
    const reachable = transitiveRelativeImports(join(ARCHIVE_SRC, 'index.ts'));

    expect(reachable.size).toBeGreaterThan(1);
    const forbidden = [...reachable].filter((file) => /\/src\/(db|server|capture)\//.test(file));
    expect(forbidden).toEqual([]);
  });

  it('(c) names no write syscall outside paths.ts, mirror.ts, lock.ts and seal.ts', () => {
    // `seal.ts` joins the allowlist because it names renameSync and unlinkSync —
    // the temp+rename publish and the removal of the hot file it just compressed.
    // `read.ts` is deliberately NOT here: the accessor names none of the six, and
    // allowlisting it would weaken the guard for nothing.
    const allowed = new Set(['paths.ts', 'mirror.ts', 'lock.ts', 'seal.ts']);
    const pattern = /\b(appendFileSync|writeFileSync|rmSync|renameSync|unlinkSync|mkdirSync)\b/;
    const offenders: string[] = [];

    for (const file of readdirSync(ARCHIVE_SRC, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      if (allowed.has(file.name)) continue;
      if (pattern.test(readFileSync(join(ARCHIVE_SRC, file.name), 'utf8'))) {
        offenders.push(file.name);
      }
    }

    expect(offenders).toEqual([]);
    // Non-vacuity: the allowlisted writer really does name one.
    expect(pattern.test(readFileSync(join(ARCHIVE_SRC, 'paths.ts'), 'utf8'))).toBe(true);
  });
});

/** Follow relative specifiers from `entry`, resolving `.js` -> `.ts`. */
function transitiveRelativeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry) || !existsSync(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const pattern = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]!;
    const resolved = join(dirname(entry), specifier.replace(/\.js$/, '.ts'));
    transitiveRelativeImports(resolved, seen);
  }
  return seen;
}
