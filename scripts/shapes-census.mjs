// A transcript corpus's shape as names and counts, never a path or a value. Runs under bare node with
// no install, so it mirrors resolveTranscriptRoot, classifyCorpusPath and the projector's uuid gate.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root =
  process.argv[2] ??
  process.env.AGENT_LENS_TRANSCRIPT_ROOT ??
  join(homedir(), '.claude', 'projects');

try {
  if (!statSync(root).isDirectory()) throw new Error('not a directory');
} catch {
  process.stderr.write(`shapes-census: no transcript directory at ${root}\n`);
  process.exit(1);
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const typeLabel = (value) =>
  typeof value === 'string' ? value : value === null ? '<null>' : `<${typeof value}>`;
const blockType = (block) => (isObject(block) && typeof block.type === 'string' ? block.type : '');
const asBlocks = (content) =>
  typeof content === 'string' ? [{ type: 'text' }] : Array.isArray(content) ? content : [];

const bump = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const sorted = (counts) =>
  Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function inCorpus(parts) {
  const leaf = parts[parts.length - 1];
  if (parts.length === 2) return leaf.endsWith('.jsonl');
  return (
    parts.length >= 4 &&
    parts[2] === 'subagents' &&
    leaf.startsWith('agent-') &&
    leaf.endsWith('.jsonl')
  );
}

let files = 0;
let lines = 0;
let unparseable = 0;
let unreadable = 0;
const versions = new Map();
const types = new Map();
const blocks = new Map();

function censusLine(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    unparseable += 1;
    return;
  }
  lines += 1;
  const line = isObject(parsed) ? parsed : {};
  const label = typeLabel(line.type);
  let entry = types.get(label);
  if (entry === undefined) {
    entry = { lines: 0, keys: new Map(), subtypes: new Map() };
    types.set(label, entry);
  }
  entry.lines += 1;
  for (const key of Object.keys(line)) bump(entry.keys, key);
  if (typeof line.subtype === 'string') bump(entry.subtypes, line.subtype);
  bump(versions, typeof line.version === 'string' ? line.version : '(none)');

  if (typeof line.uuid !== 'string') return;
  const content = isObject(line.message) ? line.message.content : undefined;
  for (const block of asBlocks(content)) {
    const type = blockType(block);
    bump(blocks, `top/${type}`);
    if (type !== 'tool_result') continue;
    for (const child of asBlocks(block.content)) bump(blocks, `in_tool_result/${blockType(child)}`);
  }
}

function walk(dir, parts) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable += 1;
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const here = [...parts, entry.name];
    if (entry.isDirectory()) {
      walk(path, here);
    } else if (entry.isFile() && inCorpus(here)) {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        unreadable += 1;
        continue;
      }
      files += 1;
      for (const line of text.split('\n')) if (line !== '') censusLine(line);
    }
  }
}

walk(root, []);

const census = {
  census: 1,
  files,
  lines,
  unparseable,
  unreadable,
  versions: sorted(versions),
  types: sorted(
    new Map(
      [...types].map(([label, entry]) => [
        label,
        { lines: entry.lines, keys: sorted(entry.keys), subtypes: sorted(entry.subtypes) },
      ]),
    ),
  ),
  blocks: sorted(blocks),
};

process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
