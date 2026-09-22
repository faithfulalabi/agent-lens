// The first-boot next-step line. `createCorpusSweep` walks `<dataDir>/archive`
// and nothing else (`corpus/watch.ts:179`), so `agent-lens start` on a machine
// that never ran `agent-lens archive` renders an empty session list — the
// headline claim of the re-architecture, silently false, with no line on screen
// saying why. This is the line, and these are its two arms.

import { describe, expect, it } from 'vitest';
import { jsonLines, SLUG, writeArchive, writeSource } from '../../archive/__tests__/fixtures.js';
import { useSandbox } from '../../archive/__tests__/use-sandbox.js';
import { emptyArchiveNotice } from '../commands/start.js';

const sb = useSandbox();

describe('emptyArchiveNotice — printed, never mirrored', () => {
  it('names both directories and the command that joins them when the archive is empty', () => {
    const s = sb();
    writeSource(s, `${SLUG}/sess-1.jsonl`, jsonLines(3));
    writeSource(s, `${SLUG}/sess-2.jsonl`, jsonLines(3));

    const notice = emptyArchiveNotice(s.dataDir, s.sourceRoot);

    expect(notice).toBeDefined();
    // TWO DIRECTORIES, NAMED SEPARATELY, `dev/server.ts:85-91`'s rule: one
    // sentence naming only the measured tree reads as though the sweep indexed
    // it, which is how an empty archive looked like a broken product.
    expect(notice).toContain(s.archiveRoot);
    expect(notice).toContain(s.sourceRoot);
    expect(notice).toContain('`agent-lens archive`');
    expect(notice).toContain('2 file(s)');
  });

  it('says nothing once the archive holds bytes', () => {
    const s = sb();
    writeSource(s, `${SLUG}/sess-1.jsonl`, jsonLines(3));
    writeArchive(s, `${SLUG}/sess-1.jsonl`, jsonLines(3));

    expect(emptyArchiveNotice(s.dataDir, s.sourceRoot)).toBeUndefined();
  });

  it('says nothing when only the archive has bytes and every source has expired', () => {
    // The state a long-running install reaches: the archive is the only copy
    // left. A notice here would tell a user to re-mirror files that are gone.
    const s = sb();
    writeArchive(s, `${SLUG}/sess-1.jsonl`, jsonLines(3));

    expect(emptyArchiveNotice(s.dataDir, s.sourceRoot)).toBeUndefined();
  });

  it('still speaks on a machine with no transcripts at all', () => {
    const s = sb();

    expect(emptyArchiveNotice(s.dataDir, s.sourceRoot)).toContain('0 file(s)');
  });
});
