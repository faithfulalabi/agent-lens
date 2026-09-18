// AC1 — the slug encoding, the path math, and the total classifier.
//
// Every assertion here is a PROPERTY. The real-corpus arms live in
// `corpus.test.ts` behind `runIt`, and they print counts rather than pinning
// them: the archive grows under a 15-minute cron.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { dirname, join } from 'node:path';
import {
  classifyCorpusPath,
  decodeProjectDir,
  encodeProjectDir,
  logicalPathOf,
  projectSlugOf,
  rowIdOf,
  sessionDirOf,
  sessionRootOf,
  subagentsDirOf,
  toolResultsDirOf,
  workflowParentOf,
  type CorpusKind,
} from '../paths.js';

const KINDS: readonly CorpusKind[] = ['session', 'sidecar', 'excluded', 'ignored'];

describe('AC1 — encodeProjectDir is total and exact', () => {
  it.each([
    ['/Users/jordan', '-Users-jordan'],
    ['/Users/jordan/Desktop/Harbor', '-Users-jordan-Desktop-Harbor'],
    // The hyphenated leaf: this is the case the decode direction cannot recover.
    ['/Users/jordan/Desktop/agent-lens', '-Users-jordan-Desktop-agent-lens'],
    [
      '/Users/jordan/Desktop/agent-lens/experiments/tracer-bullet/scratch-project',
      '-Users-jordan-Desktop-agent-lens-experiments-tracer-bullet-scratch-project',
    ],
  ])('encodes %s', (cwd, slug) => {
    expect(encodeProjectDir(cwd)).toBe(slug);
  });

  it('is total over arbitrary absolute paths — every `/` becomes `-`, nothing else moves', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }).filter((s) => !s.includes('/'))),
        (parts) => {
          const cwd = '/' + parts.join('/');
          const slug = encodeProjectDir(cwd);
          expect(slug.split('/')).toHaveLength(1);
          expect(slug.split('-').length).toBe(cwd.split('/').length + countHyphens(parts));
        },
      ),
    );
  });
});

function countHyphens(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + part.split('-').length - 1, 0);
}

describe('AC1 — decodeProjectDir is a documented seed, corrected at projection', () => {
  it('returns the naive form, and does NOT claim to be exact', () => {
    // Exact where no path component contains a hyphen…
    expect(decodeProjectDir('-Users-jordan')).toBe('/Users/jordan');
    // …and provably wrong where one does. This is the whole reason the seed is
    // superseded by WRITE_HEADER_SQL's COALESCE(:project_path, project_path).
    expect(decodeProjectDir('-Users-jordan-Desktop-agent-lens')).toBe(
      '/Users/jordan/Desktop/agent/lens',
    );
    expect(decodeProjectDir(encodeProjectDir('/Users/jordan/Desktop/agent-lens'))).not.toBe(
      '/Users/jordan/Desktop/agent-lens',
    );
  });

  it('round-trips through encode only when no component carries a hyphen', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9_.]+$/), { minLength: 1 }), (parts) => {
        const cwd = '/' + parts.join('/');
        expect(decodeProjectDir(encodeProjectDir(cwd))).toBe(cwd);
      }),
    );
  });
});

describe('AC1 — sidecar and tool-results paths are pure string math', () => {
  it('derives both from the transcript path with zero readdir calls', () => {
    const transcript = '/archive/-Users-dev-proj/abc.jsonl';
    expect(sessionDirOf(transcript)).toBe('/archive/-Users-dev-proj/abc');
    expect(subagentsDirOf(transcript)).toBe(join(sessionDirOf(transcript), 'subagents'));
    expect(toolResultsDirOf(transcript)).toBe(join(sessionDirOf(transcript), 'tool-results'));

    // The proof, and it is stronger than a spy: the module cannot call `readdir`
    // because it imports no filesystem at all. A spy would only witness the one
    // call the assertions above happen to make.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'paths.ts'),
      'utf8',
    );
    expect(source, 'src/corpus/paths.ts must stay pure string math').not.toMatch(
      /from '(node:)?fs(\/promises)?'/,
    );
  });

  it('takes the same slice foldArchive takes, and degrades for a non-transcript', () => {
    expect(sessionDirOf('/a/b/c.jsonl')).toBe('/a/b/c');
    expect(sessionDirOf('/a/b/c.meta.json')).toBe('/a/b/c.meta.json');
  });

  // ★ A SIDECAR'S SESSION ROOT IS ITS GRANDPARENT. `spill.ts:80-81` states the
  // rule; `discover.ts:11` enforces it by mirroring `tool-results/` only under
  // `<slug>/<stem>/`. Measured over 53 structured spill references: 34 sit in a
  // sidecar, and 0 of 65 archive `tool-results/` files sit under `subagents/`.
  it('anchors a sidecar at the session root, not beside its own transcript', () => {
    const top = '/archive/-Users-dev-proj/abc.jsonl';
    const root = '/archive/-Users-dev-proj/abc';

    // A top-level transcript: the root IS the sibling directory.
    expect(sessionRootOf(top)).toBe(root);

    // A flat sidecar, and the `subagents/workflows/wf_<id>/` pocket, both land
    // on the same root — which is what makes the two indistinguishable to a
    // spill resolver, exactly as `discover.ts` mirrors them.
    expect(sessionRootOf(`${root}/subagents/agent-kid.jsonl`)).toBe(root);
    expect(sessionRootOf(`${root}/subagents/workflows/wf_1/agent-deep.jsonl`)).toBe(root);

    // And `tool-results/` follows it, so one rule serves both call sites.
    expect(toolResultsDirOf(`${root}/subagents/agent-kid.jsonl`)).toBe(join(root, 'tool-results'));
    expect(toolResultsDirOf(top)).toBe(join(root, 'tool-results'));
  });

  it('sessionRootOf is idempotent and never escapes the slug', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('/archive/-slug/abc', '/a/b/c', '/x'),
        fc.integer({ min: 0, max: 3 }),
        (root, depth) => {
          const nested =
            depth === 0
              ? `${root}.jsonl`
              : `${root}/subagents/${'d/'.repeat(depth - 1)}agent-x.jsonl`;
          const once = sessionRootOf(nested);
          expect(once).toBe(root);
          // A root is already a root: re-anchoring it changes nothing but the
          // `.jsonl` strip, which it no longer has.
          expect(sessionRootOf(once)).toBe(once);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('AC1/AC3 — workflows classifies three ways', () => {
  const SESSION = `${'-Users-dev-proj'}/abc`;
  const WF = `${SESSION}/subagents/workflows/wf_18e7ec0c-db9`;

  it.each([
    [`${WF}/journal.jsonl`, 'excluded'],
    [`${WF}/agent-a752b9d.jsonl`, 'sidecar'],
    [`${WF}/agent-a752b9d.meta.json`, 'ignored'],
    [`${SESSION}/subagents/agent-a718129.jsonl`, 'sidecar'],
    [`${SESSION}/subagents/agent-a718129.meta.json`, 'ignored'],
    [`${SESSION}/tool-results/b011o0n.txt`, 'ignored'],
    ['-Users-dev-proj/abc.jsonl', 'session'],
    ['-Users-dev-proj/abc.jsonl.sha256', 'ignored'],
  ])('classifies %s as %s', (rel, kind) => {
    expect(classifyCorpusPath(rel)).toBe(kind);
  });

  it('the second workflows/ directory, in the source tree, is not a sidecar path', () => {
    // `<slug>/<stem>/workflows/scripts/x.js` is never mirrored — SESSION_SUBDIRS
    // is ['subagents','tool-results'] — so the archive walk cannot reach it. If
    // one ever appears it must not classify as anything indexable.
    expect(classifyCorpusPath(`${SESSION}/workflows/scripts/x.js`)).toBe('ignored');
    expect(classifyCorpusPath(`${SESSION}/workflows/scripts/x.jsonl`)).toBe('ignored');
  });

  it('derives a wf_ sidecar parent by path, and derives nothing else', () => {
    expect(workflowParentOf(`${WF}/agent-a752b9d.jsonl`)).toBe('abc');
    expect(workflowParentOf(`${SESSION}/subagents/agent-a718129.jsonl`)).toBeUndefined();
    expect(workflowParentOf('-Users-dev-proj/abc.jsonl')).toBeUndefined();
  });
});

describe('AC1/AC2 — a sealed path classifies identically to its hot twin', () => {
  it('strips .zst and keys both to one logical path', () => {
    const hot = '/archive/-Users-dev-proj/abc.jsonl';
    const sealed = `${hot}.zst`;

    expect(logicalPathOf(sealed)).toBe(hot);
    expect(logicalPathOf(hot)).toBe(hot);
    expect(classifyCorpusPath(logicalPathOf('-Users-dev-proj/abc.jsonl.zst'))).toBe('session');
    expect(classifyCorpusPath('-Users-dev-proj/abc.jsonl')).toBe('session');
  });
});

describe('AC2 — classifyCorpusPath is total', () => {
  it('never returns undefined, for any relative path at all', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (parts) => {
        expect(KINDS).toContain(classifyCorpusPath(parts.join('/')));
      }),
    );
  });

  it('is total for the shapes the archive actually produces', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('-Users-dev-proj', '-Users-x'),
        fc.constantFrom('abc', 'def'),
        fc.constantFrom(
          'x.jsonl',
          'subagents/agent-1.jsonl',
          'subagents/workflows/wf_1/journal.jsonl',
          'tool-results/a.txt',
        ),
        (slug, stem, tail) => {
          expect(KINDS).toContain(classifyCorpusPath(`${slug}/${stem}/${tail}`));
        },
      ),
    );
  });
});

describe('the row id a path becomes', () => {
  it('is the stem, with a sidecar agent- prefix removed so no file gets two rows', () => {
    expect(rowIdOf('-Users-dev-proj/abc.jsonl')).toBe('abc');
    expect(rowIdOf('-Users-dev-proj/abc/subagents/agent-a718129.jsonl')).toBe('a718129');
    expect(projectSlugOf('-Users-dev-proj/abc/subagents/agent-a718129.jsonl')).toBe(
      '-Users-dev-proj',
    );
  });
});
