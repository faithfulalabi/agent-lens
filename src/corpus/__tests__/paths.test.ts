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
  subagentsDirOf,
  toolResultsDirOf,
  workflowParentOf,
  type CorpusKind,
} from '../paths.js';

const KINDS: readonly CorpusKind[] = ['session', 'sidecar', 'excluded', 'ignored'];

describe('AC1 — encodeProjectDir is total and exact', () => {
  it.each([
    ['/Users/faithful', '-Users-faithful'],
    ['/Users/faithful/Desktop/Verona', '-Users-faithful-Desktop-Verona'],
    // The hyphenated leaf: this is the case the decode direction cannot recover.
    ['/Users/faithful/Desktop/agent-lens', '-Users-faithful-Desktop-agent-lens'],
    [
      '/Users/faithful/Desktop/agent-lens/experiments/tracer-bullet/scratch-project',
      '-Users-faithful-Desktop-agent-lens-experiments-tracer-bullet-scratch-project',
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
    expect(decodeProjectDir('-Users-faithful')).toBe('/Users/faithful');
    // …and provably wrong where one does. This is the whole reason the seed is
    // superseded by WRITE_HEADER_SQL's COALESCE(:project_path, project_path).
    expect(decodeProjectDir('-Users-faithful-Desktop-agent-lens')).toBe(
      '/Users/faithful/Desktop/agent/lens',
    );
    expect(decodeProjectDir(encodeProjectDir('/Users/faithful/Desktop/agent-lens'))).not.toBe(
      '/Users/faithful/Desktop/agent-lens',
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
