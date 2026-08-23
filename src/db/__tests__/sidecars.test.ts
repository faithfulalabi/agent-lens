// AC1, AC2, AC3 — the filesystem half: which sub-agent transcripts exist beside
// this one, what their spans are, and what the resolver refuses to open.
//
// Everything is synthesized under a tmpdir sandbox. The reader is the REAL one,
// wrapped in a counter, so every arm that asserts "it did not open that" is
// asserting about production code rather than about a stub.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { createArchiveReader, type ArchiveReader } from '../../archive/read.js';
import { foldSessionEnvelope } from '../../transcript/line.js';
import { enclosingSubagentsDir, readSidecars } from '../sidecars.js';
import {
  bytesRead,
  countingReader,
  CWD,
  humanLine,
  jsonl,
  machineryLine,
  newReaderLog,
  parseJsonl,
  readPaths,
  subagentsDirOf,
  writeFile,
  writeSidecarMeta,
  writeSidecarTranscript,
  writeTranscript,
  type ReaderLog,
} from './fixtures/index.js';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox !== undefined) cleanup(sandbox);
  sandbox = undefined;
});

const TS = (seconds: number): string =>
  new Date(Date.UTC(2026, 7, 14, 9, 0, seconds)).toISOString();

/** A sub-agent transcript: three timestamped lines that all carry a cwd. */
function sidecarRecords(from: number, to: number): readonly unknown[] {
  return [
    humanLine('the sub-agent brief', TS(from)),
    machineryLine('working', TS(Math.floor((from + to) / 2))),
    machineryLine('done', TS(to)),
  ];
}

interface Tree {
  parent: string;
  source: string;
  subagents: string;
}

/** A parent transcript plus an empty `subagents/`, both under the sandbox. */
function plantTree(name = 'parent'): Tree {
  const parent = join(sb().archiveRoot, `${name}.jsonl`);
  writeTranscript(parent, [humanLine('go', TS(0))]);
  return {
    parent,
    source: join(sb().sourceRoot, `${name}.jsonl`),
    subagents: subagentsDirOf(parent),
  };
}

/** The resolver, driven through a counting reader. */
function resolve(
  tree: Tree,
  ids: readonly string[],
): { log: ReaderLog; found: ReturnType<typeof readSidecars> } {
  const log = newReaderLog();
  const found = readSidecars(tree.parent, tree.source, new Set(ids), countingReader(log));
  return { log, found };
}

describe('enclosingSubagentsDir resolves one directory at every depth', () => {
  it('a parent transcript resolves to its sibling subagents directory', () => {
    expect(enclosingSubagentsDir('/a/b/sess.jsonl')).toBe('/a/b/sess/subagents');
  });

  it('a sidecar resolves to the SAME directory it already sits in', () => {
    // This is the whole of "depth 3 needs no code": every generation of a
    // session's sub-agents shares one flat listing.
    expect(enclosingSubagentsDir('/a/b/sess/subagents/agent-X.jsonl')).toBe('/a/b/sess/subagents');
  });

  it('a workflow sidecar resolves to the same ancestor', () => {
    expect(enclosingSubagentsDir('/a/b/sess/subagents/workflows/wf_1/agent-X.jsonl')).toBe(
      '/a/b/sess/subagents',
    );
  });

  it('anything that is not a transcript resolves to nothing', () => {
    expect(enclosingSubagentsDir('/a/b/sess.meta.json')).toBeUndefined();
  });
});

describe('AC1 — the walk enumerates metas, and links what carries a key', () => {
  it('a matched sidecar becomes a descriptor with its span and its mirrored source path', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'A1', sidecarRecords(10, 250));
    writeSidecarMeta(tree.subagents, 'A1', {
      agentType: 'Explore',
      description: 'look around',
      toolUseId: 'toolu_one',
      spawnDepth: 1,
    });

    const { found } = resolve(tree, ['toolu_one']);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      agent_id: 'A1',
      archive_path: join(tree.subagents, 'agent-A1.jsonl'),
      // Derived from the PARENT's source path by string math: the mirror is
      // path-identical below the two roots.
      source_path: join(sb().sourceRoot, 'parent', 'subagents', 'agent-A1.jsonl'),
      meta: { agentType: 'Explore', description: 'look around', spawnDepth: 1 },
      envelope: { project_path: CWD, started_at: TS(10), last_activity_at: TS(250) },
    });
    expect(found[0]!.size).toBe(statSync(found[0]!.archive_path).size);
  });

  it('a sidecar inside workflows/wf_*/ resolves through the same walk', () => {
    const tree = plantTree();
    const nested = join(tree.subagents, 'workflows', 'wf_1');
    writeSidecarTranscript(nested, 'W1', sidecarRecords(10, 20));
    writeSidecarMeta(nested, 'W1', { agentType: 'Explore', toolUseId: 'toolu_one' });

    const { found } = resolve(tree, ['toolu_one']);

    expect(found.map((entry) => entry.agent_id)).toStrictEqual(['W1']);
    expect(found[0]!.source_path).toBe(
      join(sb().sourceRoot, 'parent', 'subagents', 'workflows', 'wf_1', 'agent-W1.jsonl'),
    );
  });

  it('journal.jsonl is never a descriptor, because it is not an agent meta', () => {
    const tree = plantTree();
    const nested = join(tree.subagents, 'workflows', 'wf_1');
    writeFile(join(nested, 'journal.jsonl'), jsonl([{ type: 'started', key: 'k', agentId: 'W1' }]));
    writeFile(join(nested, 'journal.meta.json'), JSON.stringify({ toolUseId: 'toolu_one' }));

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });
});

describe('AC2 — malformed inputs yield no descriptor and no throw', () => {
  it('a keyless workflow meta is skipped', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'WF', sidecarRecords(10, 20));
    // The exact shape of all 12 measured `wf_*` metas.
    writeSidecarMeta(tree.subagents, 'WF', { agentType: 'workflow-subagent', spawnDepth: 1 });

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a transcript with NO sibling meta is skipped silently', () => {
    // Structural, because the walk enumerates metas — but pinned, because
    // `createArchiveReader.read` THROWS on a missing file rather than answering
    // undefined, so inverting the rule would throw inside the caller's savepoint
    // and fail the parent.
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'ORPHAN', sidecarRecords(10, 20));

    const { found, log } = resolve(tree, ['toolu_one']);
    expect(found).toStrictEqual([]);
    expect(readPaths(log)).toStrictEqual([]);
  });

  it('a meta that is not JSON at all is skipped', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'BAD', sidecarRecords(10, 20));
    writeFile(join(tree.subagents, 'agent-BAD.meta.json'), 'not json {');

    expect(() => resolve(tree, ['toolu_one'])).not.toThrow();
    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a matched sidecar whose end lines carry no cwd is dropped', () => {
    // `sessions.project_path` is TEXT NOT NULL. Binding a NULL would throw inside
    // the parent's SAVEPOINT and mark the PARENT failed.
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'NOCWD', [
      { type: 'user', uuid: 'aaaa1111-1111-4111-8111-aaaa11110000', timestamp: TS(10) },
      { type: 'user', uuid: 'bbbb1111-1111-4111-8111-bbbb11110000', timestamp: TS(20) },
    ]);
    writeSidecarMeta(tree.subagents, 'NOCWD', { toolUseId: 'toolu_one' });

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a matched sidecar whose end lines carry no timestamp is dropped', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'NOTS', [
      { type: 'user', uuid: 'cccc1111-1111-4111-8111-cccc11110000', cwd: CWD },
      // The MIDDLE line carries one, and it is deliberately not read: the two
      // ends are the whole answer.
      humanLine('middle', TS(15)),
      { type: 'user', uuid: 'dddd1111-1111-4111-8111-dddd11110000', cwd: CWD },
    ]);
    writeSidecarMeta(tree.subagents, 'NOTS', { toolUseId: 'toolu_one' });

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a transcript that vanished between the listing and the stat is dropped', () => {
    const tree = plantTree();
    const transcript = writeSidecarTranscript(tree.subagents, 'GONE', sidecarRecords(10, 20));
    writeSidecarMeta(tree.subagents, 'GONE', { toolUseId: 'toolu_one' });
    rmSync(transcript);

    expect(() => resolve(tree, ['toolu_one'])).not.toThrow();
    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a transcript that vanishes between the stat and the PREAD is dropped, not fatal', () => {
    // `foldArchive` stats and `reader.size` opens, so the file can go in between
    // — and the reader THROWS on a missing file rather than answering undefined.
    // Un-caught, that throw lands inside the caller's SAVEPOINT and marks the
    // PARENT failed. Mutation control: narrowing the resolver's catch to the
    // JSON parse alone reds this.
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'RACE', sidecarRecords(10, 20));
    writeSidecarMeta(tree.subagents, 'RACE', { toolUseId: 'toolu_one' });

    const inner = createArchiveReader();
    const racing: ArchiveReader = {
      read: (path, offset, length) => {
        if (path.endsWith('.jsonl')) throw new Error(`no archived bytes for ${path}`);
        return inner.read(path, offset, length);
      },
      size: (path) => {
        if (path.endsWith('.jsonl')) throw new Error(`no archived bytes for ${path}`);
        return inner.size(path);
      },
      stats: () => inner.stats(),
    };

    let found;
    expect(() => {
      found = readSidecars(tree.parent, tree.source, new Set(['toolu_one']), racing);
    }).not.toThrow();
    expect(found).toStrictEqual([]);
  });

  it('an empty file yields no descriptor rather than a zero-length span', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'EMPTY', '');
    writeSidecarMeta(tree.subagents, 'EMPTY', { toolUseId: 'toolu_one' });

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });
});

describe('AC3 — the head/tail answer, and what it cost', () => {
  it('equals the full-file fold, over a file whose stamps run backwards', () => {
    // `foldSessionEnvelope`'s timestamp limbs are a strict MIN/MAX, which is what
    // makes "the two ends agree with the whole file" structural rather than a
    // coincidence of file order. Measured 269/269 on the corpus.
    const tree = plantTree();
    const records = [
      humanLine('last, first', TS(50)),
      machineryLine('middle', TS(20)),
      machineryLine('first, last', TS(5)),
    ];
    writeSidecarTranscript(tree.subagents, 'REV', records);
    writeSidecarMeta(tree.subagents, 'REV', { toolUseId: 'toolu_one' });

    const whole = foldSessionEnvelope(parseJsonl(jsonl(records)).lines);
    const { found } = resolve(tree, ['toolu_one']);

    expect(found[0]!.envelope.started_at).toBe(whole.started_at);
    expect(found[0]!.envelope.last_activity_at).toBe(whole.last_activity_at);
    expect(found[0]!.envelope.started_at).toBe(TS(5));
  });

  it('reads strictly fewer bytes than the file holds', () => {
    const tree = plantTree();
    const filler = 'x'.repeat(2000);
    const records = [
      humanLine(`head ${filler}`, TS(10)),
      ...Array.from({ length: 60 }, () => machineryLine(`body ${filler}`, TS(20))),
      machineryLine(`tail ${filler}`, TS(300)),
    ];
    writeSidecarTranscript(tree.subagents, 'BIG', records);
    writeSidecarMeta(tree.subagents, 'BIG', { toolUseId: 'toolu_one' });

    const { found, log } = resolve(tree, ['toolu_one']);
    const path = found[0]!.archive_path;
    const size = statSync(path).size;

    expect(size).toBeGreaterThan(64 * 1024);
    expect(bytesRead(log, path)).toBeLessThan(size);
    expect(found[0]!.envelope.last_activity_at).toBe(TS(300));
  });

  it('a first line larger than the start window still resolves, by doubling', () => {
    // Head lines measure a median of 4,695 B and a MAX of 215,461 B, and 7 of
    // 269 exceed 64 KB — a fixed window misses the first line on those.
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'WIDE', [
      humanLine('h'.repeat(40 * 1024), TS(10)),
      machineryLine('tail', TS(90)),
    ]);
    writeSidecarMeta(tree.subagents, 'WIDE', { toolUseId: 'toolu_one' });

    const { found } = resolve(tree, ['toolu_one']);

    expect(found).toHaveLength(1);
    expect(found[0]!.envelope.started_at).toBe(TS(10));
    expect(found[0]!.envelope.last_activity_at).toBe(TS(90));
  });

  it('a line past the 1 MB cap yields NO descriptor, never a truncated guess', () => {
    const tree = plantTree();
    writeSidecarTranscript(tree.subagents, 'HUGE', [
      humanLine('h'.repeat(1_200_000), TS(10)),
      machineryLine('tail', TS(90)),
    ]);
    writeSidecarMeta(tree.subagents, 'HUGE', { toolUseId: 'toolu_one' });

    expect(resolve(tree, ['toolu_one']).found).toStrictEqual([]);
  });

  it('a single unterminated line is still both ends of itself', () => {
    const tree = plantTree();
    writeSidecarTranscript(
      tree.subagents,
      'ONELINE',
      JSON.stringify(humanLine('the only line', TS(10))),
    );
    writeSidecarMeta(tree.subagents, 'ONELINE', { toolUseId: 'toolu_one' });

    const { found } = resolve(tree, ['toolu_one']);
    expect(found[0]!.envelope.started_at).toBe(TS(10));
    expect(found[0]!.envelope.last_activity_at).toBe(TS(10));
  });
});

describe('AC3 — the resolver preads only the sidecars this session launched', () => {
  /** Five sidecars in one directory; the parent below launches exactly two. */
  function plantFive(): Tree {
    const tree = plantTree('fanout');
    for (const [index, id] of ['A1', 'A2', 'B1', 'B2', 'B3'].entries()) {
      writeSidecarTranscript(tree.subagents, id, sidecarRecords(10 + index, 100 + index));
      writeSidecarMeta(tree.subagents, id, { agentType: 'Explore', toolUseId: `toolu_${id}` });
    }
    return tree;
  }

  it('reads all five metas and opens exactly the two matched transcripts', () => {
    const tree = plantFive();
    const { found, log } = resolve(tree, ['toolu_A1', 'toolu_A2']);

    expect(found.map((entry) => entry.agent_id).sort()).toStrictEqual(['A1', 'A2']);
    // Every meta is read — the join key lives inside it, at a measured median of
    // 130 B — and nothing else is opened.
    expect(readPaths(log, '.meta.json')).toHaveLength(5);
    expect(readPaths(log, '.jsonl').sort()).toStrictEqual(
      [join(tree.subagents, 'agent-A1.jsonl'), join(tree.subagents, 'agent-A2.jsonl')].sort(),
    );
  });

  it('mutation control: asking for all five opens all five', () => {
    // The same tree with the gate widened. Un-narrowed, projecting a 44-sidecar
    // tree does this work 45 times over on every live tick.
    const tree = plantFive();
    const { log } = resolve(tree, ['toolu_A1', 'toolu_A2', 'toolu_B1', 'toolu_B2', 'toolu_B3']);

    expect(readPaths(log, '.jsonl')).toHaveLength(5);
  });

  it('a leaf that launched nothing returns before the readdir', () => {
    const tree = plantFive();
    const log = newReaderLog();

    expect(readSidecars(tree.parent, tree.source, new Set(), countingReader(log))).toStrictEqual(
      [],
    );
    expect(log.reads).toStrictEqual([]);
    expect(log.sizes).toStrictEqual([]);
  });

  it('a sidecar resolving its OWN children sees the same flat directory', () => {
    // Depth 2 asking depth 3, through the same function and the same listing.
    const tree = plantFive();
    const leaf = join(tree.subagents, 'agent-A1.jsonl');
    const leafSource = join(sb().sourceRoot, 'fanout', 'subagents', 'agent-A1.jsonl');
    const log = newReaderLog();

    const found = readSidecars(leaf, leafSource, new Set(['toolu_B3']), countingReader(log));

    expect(found.map((entry) => entry.agent_id)).toStrictEqual(['B3']);
    expect(found[0]!.source_path).toBe(
      join(sb().sourceRoot, 'fanout', 'subagents', 'agent-B3.jsonl'),
    );
  });
});
