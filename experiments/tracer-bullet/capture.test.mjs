import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { selectSessionRows, rowToEnvelope, rawOutDir, buildManifest } from './capture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function envelope(overrides = {}) {
  return {
    event_id: 'sess-1:hook:PreToolUse:tool-abc',
    session_id: 'sess-1',
    harness: 'claude-code',
    source: 'hook',
    hook_name: 'PreToolUse',
    ts: '2026-07-25T18:22:03.914Z',
    raw_payload: { tool: 'bash' },
    ...overrides,
  };
}

describe('rowToEnvelope fails loud on a pre-2.3 row', () => {
  it('returns the envelope when raw holds the whole envelope', () => {
    const env = envelope();
    expect(rowToEnvelope({ id: 'r1', raw: JSON.stringify(env) })).toEqual(env);
  });

  it('throws when raw holds only raw_payload (the pre-2.3 storage shape)', () => {
    // 062cc6a:src/db/index.ts:53 bound JSON.stringify(envelope.raw_payload).
    // Silently accepting that row produces fixtures that 400 at /api/ingest —
    // discovered only in Phase 2. Fail at capture time instead.
    const row = { id: 'r1', raw: JSON.stringify({ tool: 'bash', cmd: 'ls' }) };
    expect(() => rowToEnvelope(row)).toThrow(/does not hold a full envelope/);
    expect(() => rowToEnvelope(row)).toThrow(/2\.3/);
  });

  it('throws when event_id is present but not a string', () => {
    const row = { id: 'r1', raw: JSON.stringify({ event_id: 42, session_id: 's' }) };
    expect(() => rowToEnvelope(row)).toThrow(/does not hold a full envelope/);
  });

  it('throws when raw is not JSON at all', () => {
    expect(() => rowToEnvelope({ id: 'r1', raw: 'not json' })).toThrow();
  });
});

describe('rawOutDir is anchored to the repo, not the cwd', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it('resolves under <repo>/fixtures/raw/<exp>', () => {
    expect(rawOutDir('multi-turn')).toBe(join(repoRoot, 'fixtures', 'raw', 'multi-turn'));
  });

  it('is unchanged when the operator stands in scratch-project', () => {
    // README.md:48 and setup.sh:39 both tell the operator to cd into
    // scratch-project first; under process.cwd() that put un-scrubbed raw at
    // experiments/tracer-bullet/scratch-project/fixtures/raw/<exp>.
    process.chdir(join(repoRoot, 'experiments', 'tracer-bullet', 'scratch-project'));
    expect(rawOutDir('subagent')).toBe(join(repoRoot, 'fixtures', 'raw', 'subagent'));
    expect(rawOutDir('subagent')).not.toContain(`${sep}scratch-project${sep}`);
  });

  it('is unchanged from an unrelated directory', () => {
    process.chdir(tmpdir());
    expect(rawOutDir('compaction')).toBe(join(repoRoot, 'fixtures', 'raw', 'compaction'));
  });
});

describe('buildManifest', () => {
  const envelopes = [
    envelope({ hook_name: 'SessionStart' }),
    envelope({ hook_name: 'UserPromptSubmit' }),
    envelope({ hook_name: 'UserPromptSubmit' }),
    envelope({ hook_name: 'PostToolUse' }),
    envelope({ hook_name: undefined }),
  ];
  const manifest = buildManifest({
    exp: 'multi-turn',
    sessionId: '46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60',
    envelopes,
    pathMap: {
      '/Users/realperson/.claude/projects/p/46f49151.jsonl': 'transcripts/parent.jsonl',
      '/Users/realperson/.claude/projects/p/46f49151/tool-results/bz1je72dk.txt':
        'tool-results/bz1je72dk.txt',
    },
    claudeCodeVersion: '2.1.197',
    nodeVersion: 'v26.0.0',
  });

  it('carries exactly the minimal contract fields', () => {
    expect(Object.keys(manifest).sort()).toEqual([
      'claude_code_version',
      'exp',
      'hook_counts',
      'node_version',
      'path_map',
      'session_id',
    ]);
  });

  it('records the experiment, session, and versions', () => {
    expect(manifest.exp).toBe('multi-turn');
    expect(manifest.session_id).toBe('46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60');
    expect(manifest.claude_code_version).toBe('2.1.197');
    expect(manifest.node_version).toBe('v26.0.0');
  });

  it('counts envelopes by hook name', () => {
    expect(manifest.hook_counts).toEqual({
      PostToolUse: 1,
      SessionStart: 1,
      UserPromptSubmit: 2,
      unknown: 1,
    });
  });

  it('maps each captured absolute path to its fixture-relative file', () => {
    // Phase 3's tailer cannot resolve a transcript_path that no longer exists
    // on disk without this. The keys are written raw and anonymized by the
    // scrub pass, exactly as the envelopes are, so the two sides stay joinable.
    expect(manifest.path_map['/Users/realperson/.claude/projects/p/46f49151.jsonl']).toBe(
      'transcripts/parent.jsonl',
    );
  });

  it('is deterministic and key-sorted (diff-stable across re-captures)', () => {
    const again = buildManifest({
      exp: 'multi-turn',
      sessionId: '46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60',
      envelopes: [...envelopes].reverse(),
      pathMap: {
        '/Users/realperson/.claude/projects/p/46f49151/tool-results/bz1je72dk.txt':
          'tool-results/bz1je72dk.txt',
        '/Users/realperson/.claude/projects/p/46f49151.jsonl': 'transcripts/parent.jsonl',
      },
      claudeCodeVersion: '2.1.197',
      nodeVersion: 'v26.0.0',
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(manifest));
  });

  it('defaults an unrecorded Claude Code version rather than omitting the field', () => {
    const bare = buildManifest({ exp: 'x', sessionId: 's', envelopes: [], pathMap: {} });
    expect(bare.claude_code_version).toBe('unknown');
    expect(bare.node_version).toBe(process.version);
    expect(bare.hook_counts).toEqual({});
  });
});

describe('selectSessionRows', () => {
  function seedDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE raw_events (id TEXT PRIMARY KEY, session_id TEXT, source TEXT, hook_name TEXT, received_at TEXT, status TEXT, raw TEXT)',
    );
    const insert = db.prepare('INSERT INTO raw_events VALUES (?,?,?,?,?,?,?)');
    insert.run('r2', 'sess-a', 'hook', 'Stop', '2026-07-25T00:00:02Z', 'processed', '{}');
    insert.run('r1', 'sess-a', 'hook', 'SessionStart', '2026-07-25T00:00:01Z', 'processed', '{}');
    insert.run('r3', 'sess-b', 'hook', 'SessionStart', '2026-07-25T00:00:03Z', 'processed', '{}');
    return db;
  }

  it('filters to one session, ordered by received_at', () => {
    const db = seedDb();
    expect(selectSessionRows(db, 'sess-a').map((r) => r.id)).toEqual(['r1', 'r2']);
    db.close();
  });

  it('returns every row when no session is given', () => {
    const db = seedDb();
    expect(selectSessionRows(db).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    db.close();
  });
});
