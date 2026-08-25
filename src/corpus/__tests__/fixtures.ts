// Sandbox trees for the corpus sweep. Everything is synthesized; the arms that
// read `~/.agent-lens/archive` live in `corpus.test.ts` behind `runIt`.
//
// The generic halves are IMPORTED, not copied: `makeSandbox`/`cleanup` and
// `compressLikeSeal` from the archive suite, the line builders from the db
// suite. Both are the cross-tree precedent `db/__tests__/fixtures/index.ts:5-9`
// records.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cleanup,
  compressLikeSeal,
  makeSandbox,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import {
  humanLine,
  jsonl,
  toolCallLine,
  toolResultLine,
} from '../../db/__tests__/fixtures/index.js';

export { cleanup, makeSandbox, type Sandbox };

/** The slug whose decode agrees with the cwd the line builders write. */
export const SLUG = '-Users-dev-proj';
export const CWD = '/Users/dev/proj';

function write(path: string, body: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** A transcript with a human prompt, one `Agent` call and its result. */
export function sessionRecords(callId: string, startedAt: string, endedAt: string): unknown[] {
  return [
    humanLine('do the thing', startedAt),
    toolCallLine(callId, 'Agent', startedAt),
    toolResultLine(callId, 'done', endedAt),
  ];
}

/**
 * A top-level transcript at `<archiveRoot>/<slug>/<id>.jsonl`.
 *
 * The first line is a `type:"mode"` control line carrying neither `cwd` nor
 * `timestamp`, exactly as all 26 real transcripts open — which is what makes the
 * two-end fold wrong and the windowed fold right.
 */
export function writeSession(
  sandbox: Sandbox,
  id: string,
  records: readonly unknown[],
  slug = SLUG,
): string {
  const body = jsonl([{ type: 'mode', mode: 'default' }, ...records]);
  return write(join(sandbox.archiveRoot, slug, `${id}.jsonl`), body);
}

/** The same transcript, sealed. The logical path is the returned one minus `.zst`. */
export function writeSealedSession(
  sandbox: Sandbox,
  id: string,
  records: readonly unknown[],
  slug = SLUG,
): string {
  const body = jsonl([{ type: 'mode', mode: 'default' }, ...records]);
  const logical = join(sandbox.archiveRoot, slug, `${id}.jsonl`);
  write(`${logical}.zst`, compressLikeSeal(body));
  return logical;
}

export interface SidecarOptions {
  /** Omit to write a `wf_*` meta, which carries no join key. */
  toolUseId?: string;
  /** Puts the pair under `subagents/workflows/<dir>/` instead of `subagents/`. */
  workflowDir?: string;
  sealed?: boolean;
}

/** One `agent-<id>.jsonl` + `agent-<id>.meta.json` pair under a session. */
export function writeSidecar(
  sandbox: Sandbox,
  sessionStem: string,
  agentId: string,
  records: readonly unknown[],
  options: SidecarOptions = {},
  slug = SLUG,
): string {
  const dir =
    options.workflowDir === undefined
      ? join(sandbox.archiveRoot, slug, sessionStem, 'subagents')
      : join(sandbox.archiveRoot, slug, sessionStem, 'subagents', 'workflows', options.workflowDir);

  const body = jsonl(records);
  const archivePath = join(dir, `agent-${agentId}.jsonl`);
  if (options.sealed === true) write(`${archivePath}.zst`, compressLikeSeal(body));
  else write(archivePath, body);

  const meta: Record<string, unknown> = { agentType: 'Explore', spawnDepth: 1 };
  if (options.toolUseId !== undefined) meta['toolUseId'] = options.toolUseId;
  write(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));

  return archivePath;
}

/** The workflow span log the 2026-08-19 ruling excludes: no timestamp, no cwd. */
export function writeJournal(
  sandbox: Sandbox,
  sessionStem: string,
  workflowDir: string,
  slug = SLUG,
): string {
  const body = jsonl([
    { type: 'started', key: 'a', agentId: 'x' },
    { type: 'result', key: 'a', agentId: 'x', result: 'ok' },
  ]);
  return write(
    join(
      sandbox.archiveRoot,
      slug,
      sessionStem,
      'subagents',
      'workflows',
      workflowDir,
      'journal.jsonl',
    ),
    body,
  );
}

/** A spilled tool result, which is what makes `tool-results/` non-empty. */
export function writeToolResult(
  sandbox: Sandbox,
  sessionStem: string,
  name: string,
  body = 'spilled',
  slug = SLUG,
): string {
  return write(join(sandbox.archiveRoot, slug, sessionStem, 'tool-results', `${name}.txt`), body);
}
