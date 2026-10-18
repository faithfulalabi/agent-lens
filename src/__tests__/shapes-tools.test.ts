import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { diffCensus, type Census, type DeltaRow } from '../../scripts/shapes-diff.js';
import { classifyCorpusPath } from '../corpus/paths.js';
import { runPipeline } from '../project/pipeline.js';
import { DriftCounter } from '../transcript/drift.js';
import { classifyLine } from '../transcript/line.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CENSUS_SCRIPT = join(REPO_ROOT, 'scripts', 'shapes-census.mjs');
const DIFF_SCRIPT = join(REPO_ROOT, 'scripts', 'shapes-diff.ts');
const FIXTURES = join(REPO_ROOT, 'src', 'transcript', '__tests__', 'fixtures');
const SHAPE_BUCKETS = ['unknown_top_level_fields', 'unknown_line_types', 'unknown_block_types'];

type CensusOutput = Required<Census> & { files: number; lines: number; unreadable: number };

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-shapes-'));
  sandboxes.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function jsonl(...lines: unknown[]): string {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  if (!('AGENT_LENS_TRANSCRIPT_ROOT' in overrides)) delete env.AGENT_LENS_TRANSCRIPT_ROOT;
  return env;
}

function census(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CENSUS_SCRIPT, ...args], {
    encoding: 'utf8',
    env: childEnv(env),
  });
}

function censusOf(root: string): CensusOutput {
  const run = census([root]);
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as CensusOutput;
}

function diff(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', DIFF_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv(env),
  });
}

function fixtureFiles(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [`fixtures/${name}`, readFileSync(join(FIXTURES, name), 'utf8')]),
  );
}

type Tally = Record<string, Record<string, number>>;

function tally(into: Tally, bucket: string, name: string, count: number): void {
  into[bucket] ??= {};
  into[bucket][name] = (into[bucket][name] ?? 0) + count;
}

const SENTINEL_CWD = '/Users/sentinel-person/sentinel-project';

const SENTINEL_CORPUS = {
  'proj/session.jsonl': jsonl(
    {
      type: 'user',
      uuid: 'u1',
      cwd: SENTINEL_CWD,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'SENTINEL top text' },
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'SENTINEL nested text' },
              { type: 'tool_reference', tool_name: 'SENTINEL_TOOL' },
            ],
          },
        ],
      },
    },
    { type: 'system', subtype: 'api_error', uuid: 's1', error: 'SENTINEL error body' },
    'SENTINEL this line is not json',
  ),
};

describe('shapes census', () => {
  it('reports per-type keys, system subtypes and positioned block types', () => {
    const output = censusOf(sandbox(SENTINEL_CORPUS));

    expect(output).toMatchObject({ census: 1, files: 1, lines: 2, unparseable: 1, unreadable: 0 });
    expect(output.types).toEqual({
      system: {
        lines: 1,
        keys: { error: 1, subtype: 1, type: 1, uuid: 1 },
        subtypes: { api_error: 1 },
      },
      user: { lines: 1, keys: { cwd: 1, message: 1, type: 1, uuid: 1 }, subtypes: {} },
    });
    expect(output.blocks).toEqual({
      'in_tool_result/text': 1,
      'in_tool_result/tool_reference': 1,
      'top/text': 1,
      'top/tool_result': 1,
    });
  });

  it('prints no file path and no message text', () => {
    const root = sandbox(SENTINEL_CORPUS);
    const { stdout } = census([root]);

    expect(stdout).toContain('"census": 1');
    expect(stdout).not.toContain('SENTINEL');
    expect(stdout).not.toContain('sentinel');
    expect(stdout).not.toContain(root);
    expect(stdout).not.toContain('/Users/');
  });

  it('imports nothing but node builtins, so it runs with no install', () => {
    const { importedFiles } = ts.preProcessFile(readFileSync(CENSUS_SCRIPT, 'utf8'), true, true);
    const names = importedFiles.map((file) => file.fileName);

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !name.startsWith('node:'))).toEqual([]);
  });

  it('reads exactly the files the corpus sweep classifies as sessions or sidecars', () => {
    const rels = [
      'p/a.jsonl',
      'p/a/subagents/agent-1.jsonl',
      'p/a/subagents/workflows/wf_1/agent-2.jsonl',
      'p/a/subagents/workflows/wf_1/journal.jsonl',
      'p/a/subagents/notes.jsonl',
      'p/a/deep.jsonl',
      'p/a/tool-results/agent-3.jsonl',
      'p/b.txt',
      'top.jsonl',
    ];
    const marker = (index: number) => `file-${index}`;
    const root = sandbox(
      Object.fromEntries(rels.map((rel, index) => [rel, jsonl({ type: marker(index) })])),
    );
    const expected = rels.flatMap((rel, index) =>
      ['session', 'sidecar'].includes(classifyCorpusPath(rel)) ? [marker(index)] : [],
    );

    expect(Object.keys(censusOf(root).types).sort()).toEqual(expected.sort());
  });

  it('defaults to AGENT_LENS_TRANSCRIPT_ROOT before the home directory', () => {
    const root = sandbox({ 'p/s.jsonl': jsonl({ type: 'from-env-root' }) });
    const home = sandbox({ '.claude/projects/p/s.jsonl': jsonl({ type: 'from-home' }) });
    const run = census([], { AGENT_LENS_TRANSCRIPT_ROOT: root, HOME: home });

    expect(Object.keys(JSON.parse(run.stdout).types)).toEqual(['from-env-root']);
  });

  it('exits 1 when the root does not exist', () => {
    const run = census([join(sandbox({}), 'missing')]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  });
});

describe('shapes diff', () => {
  it('finds no delta in fixtures production already reads as clean', () => {
    const output = censusOf(sandbox(fixtureFiles(['all-types.jsonl', 'system-subtypes.jsonl'])));

    expect(output.lines).toBeGreaterThan(0);
    expect(diffCensus(output)).toEqual([]);
  });

  it('finds no delta in the subtype and block census already ruled clean', () => {
    const ruledClean: Census = {
      types: { system: { lines: 2, keys: {}, subtypes: { turn_duration: 2 } } },
      blocks: {
        'top/text': 671,
        'top/tool_use': 2223,
        'top/tool_result': 2222,
        'top/thinking': 1108,
        'in_tool_result/tool_reference': 7,
        'in_tool_result/text': 33,
        'in_tool_result/image': 21,
      },
    };

    expect(diffCensus(ruledClean)).toEqual([]);
  });

  it.each<[string, Census, DeltaRow[]]>([
    [
      'an invented field, owned by its line type',
      { types: { user: { lines: 3, keys: { type: 3, uuid: 3, inventedField: 2 } } } },
      [{ bucket: 'unknown_top_level_fields', name: 'inventedField', owner: 'user', count: 2 }],
    ],
    [
      'an invented system subtype',
      {
        types: {
          system: {
            lines: 3,
            keys: { type: 3, subtype: 3 },
            subtypes: { turn_duration: 1, inventedSubtype: 2 },
          },
        },
      },
      [{ bucket: 'unknown_line_types', name: 'system.inventedSubtype', owner: '-', count: 2 }],
    ],
    [
      'an invented line type, without counting its fields',
      { types: { inventedType: { lines: 2, keys: { type: 2, inventedField: 2 } } } },
      [{ bucket: 'unknown_line_types', name: 'inventedType', owner: '-', count: 2 }],
    ],
    [
      'a non-string line type under its label',
      { types: { '<number>': { lines: 1, keys: { type: 1 } } } },
      [{ bucket: 'unknown_line_types', name: '<number>', owner: '-', count: 1 }],
    ],
    [
      'an invented top-level block type',
      { blocks: { 'top/inventedBlock': 4 } },
      [{ bucket: 'unknown_block_types', name: 'inventedBlock', owner: '-', count: 4 }],
    ],
    [
      'a tool_reference at the top level, where it is illegal',
      { blocks: { 'top/tool_reference': 5 } },
      [{ bucket: 'unknown_block_types', name: 'tool_reference', owner: '-', count: 5 }],
    ],
    [
      'nothing for a tool_reference nested in a result',
      { blocks: { 'in_tool_result/tool_reference': 5 } },
      [],
    ],
  ])('reports %s', (_, input, expected) => {
    expect(diffCensus(input)).toEqual(expected);
  });

  it('agrees with a real projection on every fixture and on the gates the census mirrors', () => {
    const files = fixtureFiles(readdirSync(FIXTURES).filter((name) => name.endsWith('.jsonl')));
    files['gates/edge.jsonl'] = jsonl(
      { type: 'user', message: { content: [{ type: 'inventedOffGate' }] } },
      { type: 'user', uuid: 'u1', message: { content: 'a bare string' } },
      { type: 'user', uuid: 'u2', message: [{ type: 'inventedInArray' }] },
      {
        type: 'user',
        uuid: 'u3',
        message: { content: [{ type: 'tool_result', content: [{ type: 'inventedNested' }] }] },
      },
      { type: 'assistant', uuid: 'u4', message: { content: [7, { type: 7 }, 'loose'] } },
      { type: 'system', uuid: 'u5', subtype: 3 },
      null,
      [1, 2],
      42,
    );

    const replayed: Tally = {};
    for (const row of diffCensus(censusOf(sandbox(files)))) {
      tally(replayed, row.bucket, row.name, row.count);
    }

    const projected: Tally = {};
    for (const [name, text] of Object.entries(files)) {
      const drift = new DriftCounter();
      const lines = text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => classifyLine(JSON.parse(line), { byteOffset: 0, byteLength: 0, drift }));
      runPipeline(lines, { session_id: name, drift });
      const serialized = JSON.parse(drift.serialize()) as Tally;
      for (const bucket of SHAPE_BUCKETS) {
        for (const [key, count] of Object.entries(serialized[bucket] ?? {})) {
          tally(projected, bucket, key, count);
        }
      }
    }

    expect(Object.keys(projected).sort()).toEqual([...SHAPE_BUCKETS].sort());
    expect(replayed).toEqual(projected);
  });

  it('judges through the production classifier and pipeline rather than its own rules', () => {
    const source = ts.createSourceFile(
      DIFF_SCRIPT,
      readFileSync(DIFF_SCRIPT, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const imported = new Map<string, string[]>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
      imported.set(
        statement.moduleSpecifier.text,
        names.map((element) => element.name.text),
      );
    }

    expect(imported.get('../src/transcript/line.js')).toContain('classifyLine');
    expect(imported.get('../src/transcript/drift.js')).toContain('DriftCounter');
    expect(imported.get('../src/project/pipeline.js')).toContain('runPipeline');
  });
});

describe('shapes commands', () => {
  it('are npm scripts that name files in the repo', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(scripts['shapes:census']).toBe('node scripts/shapes-census.mjs');
    expect(scripts['shapes:diff']).toBe('node --import tsx scripts/shapes-diff.ts');
    for (const name of ['shapes:census', 'shapes:diff']) {
      expect(existsSync(join(REPO_ROOT, scripts[name]!.split(' ').at(-1)!))).toBe(true);
    }
  });

  it('are documented for contributors', () => {
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');

    expect(contributing).toContain('npm run -s shapes:census');
    expect(contributing).toContain('npm run shapes:diff');
  });

  it('diffs the local corpus under HOME when given no census', () => {
    const home = sandbox({
      '.claude/projects/p/s.jsonl': jsonl({ type: 'user', uuid: 'u1', inventedLocalField: 1 }),
    });
    const run = diff([], { HOME: home });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('unknown_top_level_fields\tinventedLocalField\tuser\t1');
  });

  it('reads a census wrapped in npm banner text and warns about unparseable lines', () => {
    const pasted: Census = {
      unparseable: 2,
      types: { user: { lines: 1, keys: { type: 1, inventedPastedField: 1 } } },
    };
    const dir = sandbox({
      'census.json': `> pkg@1.0.0 shapes:census\n> node scripts/shapes-census.mjs\n\n${JSON.stringify(pasted)}\n`,
    });
    const run = diff([join(dir, 'census.json')]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('inventedPastedField');
    expect(run.stderr).toContain('2 unparseable line(s)');
  });

  it('says so when there is no delta', () => {
    const dir = sandbox({ 'census.json': JSON.stringify({ types: {}, blocks: {} }) });
    const run = diff([join(dir, 'census.json')]);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('no delta');
  });
});
