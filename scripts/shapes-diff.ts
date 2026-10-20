// Replays a census through production's classifier and pipeline. Synthetic lines set every key to
// null because drift reads key names only; type, subtype and block types stay real values.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/project/pipeline.js';
import { DriftCounter } from '../src/transcript/drift.js';
import { classifyLine } from '../src/transcript/line.js';

export interface Census {
  unparseable?: number;
  types?: Record<
    string,
    { lines: number; keys?: Record<string, number>; subtypes?: Record<string, number> }
  >;
  blocks?: Record<string, number>;
}

type ShapeBucket = 'unknown_top_level_fields' | 'unknown_line_types' | 'unknown_block_types';

export interface DeltaRow {
  bucket: ShapeBucket;
  name: string;
  /** The line type a field was seen on; `-` for line-type and block rows. */
  owner: string;
  count: number;
}

const CENSUS_SCRIPT = fileURLToPath(new URL('./shapes-census.mjs', import.meta.url));

function judge(
  line: Record<string, unknown>,
): Partial<Record<ShapeBucket, Record<string, number>>> {
  const drift = new DriftCounter();
  const parsed = classifyLine(line, { byteOffset: 0, byteLength: 0, drift });
  runPipeline([parsed], { session_id: 'shapes-diff', drift });
  return JSON.parse(drift.serialize());
}

function synthetic(type: string, keys: Record<string, number>, subtype: string | undefined) {
  const line: Record<string, unknown> = Object.fromEntries(Object.keys(keys).map((k) => [k, null]));
  line.type = type;
  if (subtype !== undefined) line.subtype = subtype;
  return line;
}

export function diffCensus(census: Census): DeltaRow[] {
  const rows = new Map<string, DeltaRow>();
  const add = (row: DeltaRow): void => {
    const key = JSON.stringify([row.bucket, row.name, row.owner]);
    const seen = rows.get(key);
    if (seen === undefined) rows.set(key, row);
    else seen.count += row.count;
  };

  for (const [type, entry] of Object.entries(census.types ?? {})) {
    const keys = entry.keys ?? {};
    const variants: [string | undefined, number][] = Object.entries(entry.subtypes ?? {});
    const rest = entry.lines - variants.reduce((sum, [, n]) => sum + n, 0);
    if (rest > 0) variants.push([undefined, rest]);
    for (const [subtype, lines] of variants) {
      const { unknown_line_types } = judge(synthetic(type, keys, subtype));
      for (const name of Object.keys(unknown_line_types ?? {})) {
        add({ bucket: 'unknown_line_types', name, owner: '-', count: lines });
      }
    }
    const { unknown_top_level_fields } = judge(synthetic(type, keys, undefined));
    for (const name of Object.keys(unknown_top_level_fields ?? {})) {
      add({ bucket: 'unknown_top_level_fields', name, owner: type, count: keys[name] ?? 0 });
    }
  }

  for (const [key, count] of Object.entries(census.blocks ?? {})) {
    const [position, ...rest] = key.split('/');
    const block = { type: rest.join('/') };
    const content = position === 'top' ? [block] : [{ type: 'tool_result', content: [block] }];
    const { unknown_block_types } = judge({
      type: 'assistant',
      uuid: 'shapes-diff',
      message: { content },
    });
    for (const name of Object.keys(unknown_block_types ?? {})) {
      add({ bucket: 'unknown_block_types', name, owner: '-', count });
    }
  }

  return [...rows.values()];
}

function fail(message: string): never {
  process.stderr.write(`shapes-diff: ${message}\n`);
  process.exit(1);
}

function censusText(file: string | undefined): string {
  if (file !== undefined) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return fail(`cannot read ${file}`);
    }
  }
  const run = spawnSync(process.execPath, [CENSUS_SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) return fail('the census failed');
  return run.stdout;
}

/** From the first `{` to the last `}`, so an npm banner or chat text around a paste is ignored. */
function parseCensus(text: string): Census {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return fail('no census JSON found');
  }
}

function main(argv: string[]): void {
  if (argv.length > 1) fail('usage: shapes-diff.ts [census.json]');
  const census = parseCensus(censusText(argv[0]));
  if ((census.unparseable ?? 0) > 0) {
    process.stderr.write(
      `shapes-diff: warning: ${census.unparseable} unparseable line(s); production fails the ` +
        `projection of any file holding one, so that file's drift is never stored\n`,
    );
  }
  const rows = diffCensus(census);
  if (rows.length === 0) {
    console.log('no delta');
    return;
  }
  console.log(['bucket', 'name', 'owner', 'count'].join('\t'));
  for (const row of rows) console.log([row.bucket, row.name, row.owner, row.count].join('\t'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
