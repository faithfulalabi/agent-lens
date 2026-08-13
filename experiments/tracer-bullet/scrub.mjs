// The scrubber — the mandatory gate between raw captures and committed
// fixtures. Data-model classifies raw payloads as sensitive (may echo secrets),
// so nothing under fixtures/raw/ may ever be committed. This pass reads a raw
// capture directory, applies the deterministic rules in scrub.config.json plus
// home-dir/username anonymization, and writes shape-preserving output to
// fixtures/scrubbed/. It is deterministic (same input -> same output) and
// preserves JSON structure and Q3 size markers so scrubbed fixtures still
// replay through /api/ingest unchanged. A manual eyeball gate (SCRUBBING.md)
// is STILL required afterward — this tool reduces risk, it does not eliminate
// the "assume worst" posture — followed by `verify.mjs`, the independent
// residue gate.
//
// Two passes, chosen by extension: `.jsonl` files go through `scrubJsonl`
// (structural attachment stripping, then the text rules); everything else
// (`manifest.json`, `tool-results/*.txt`) goes straight through `scrubText`.
//
// Run: node scrub.mjs --in fixtures/raw/<exp> --out fixtures/scrubbed/<exp> \
//        --config scrub.config.json --home "$HOME" --user "$USER"
// Importable: `import { compileRules, scrubText, scrubJsonl } from "./scrub.mjs"`.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

/**
 * Compile the JSON config's string patterns into RegExp objects. A leading
 * `(?i)` inline flag is honored (JS lacks inline flags) by lifting it to the
 * `i` flag. All rules are global. Throws on an invalid pattern so a broken
 * config fails loud rather than silently under-redacting.
 *
 * `key` selects which rule set to compile: `rules` (the redactor, used by
 * scrubText) or `detectRules` (the deliberately-looser verification set, used
 * only by verify.mjs). One compiler, one config file, two independent sets —
 * so the gate cross-checks the scrubber instead of restating it.
 *
 * @param {Record<string, Array<{name:string, pattern:string, replacement?:string}>>} config
 * @param {'rules'|'detectRules'} [key]
 * @returns {Array<{name:string, regex:RegExp, replacement:string}>}
 */
export function compileRules(config, key = 'rules') {
  const declared = config[key];
  if (!Array.isArray(declared)) {
    throw new Error(`scrub config has no "${key}" array`);
  }
  return declared.map((rule) => {
    let source = rule.pattern;
    let flags = 'g';
    if (source.startsWith('(?i)')) {
      source = source.slice(4);
      flags += 'i';
    }
    return { name: rule.name, regex: new RegExp(source, flags), replacement: rule.replacement };
  });
}

/**
 * Apply every compiled rule, then anonymize home dir + username, to one string.
 * Rules run in declaration order; replacement supports `$1` backreferences.
 *
 * @param {string} text
 * @param {Array<{regex:RegExp, replacement:string}>} rules
 * @param {{home?:string, user?:string, homePlaceholder:string, userPlaceholder:string}} anon
 * @returns {string}
 */
export function scrubText(text, rules, anon) {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.regex, rule.replacement);
  }
  if (anon.home && anon.home.length > 0) {
    out = out.split(anon.home).join(anon.homePlaceholder);
  }
  if (anon.user && anon.user.length > 0) {
    out = out.split(anon.user).join(anon.userPlaceholder);
  }
  return out;
}

/**
 * Structurally strip one JSONL transcript line's `attachment` body.
 *
 * Claude Code transcripts carry `type:"attachment"` lines whose body is the
 * operator's installed skill/agent/MCP inventory — measured at 63-66% of
 * transcript bytes on the Task 1.5 captures, and a pure environment-config leak
 * with zero fixture value. Regex cannot reach it (scrubText is a flat text
 * pass with no JSON awareness), so this runs first.
 *
 * The line is KEPT, not dropped: line count, ordering, and the
 * `uuid`/`parentUuid` chain must survive so the scrubbed transcript still
 * exercises Phase 3's append-only tailer. Only `attachment` is replaced, by
 * `{type:<original kind>, stripped:true}`. Every other key keeps its original
 * value and position (the object is mutated in place, so JSON.stringify
 * re-emits the same key order).
 *
 * Anything that is not an attachment line — including a non-JSON line — is
 * returned byte-identical, so the caller's text pass still sees it verbatim.
 * `scrubJsonl` refuses to accept an unparseable line at all; see there.
 *
 * @param {string} line one JSONL line, no trailing newline.
 * @param {{strip?: {attachmentTypes?: string[], stripAllAttachments?: boolean}}} cfg
 * @returns {string}
 */
export function stripAttachmentLine(line, cfg) {
  const parsed = parseJsonLine(line);
  return parsed === undefined ? line : stripParsedLine(parsed, line, cfg);
}

/** Parse one JSONL line, or `undefined` for an empty or unparseable one. */
function parseJsonLine(line) {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Apply the structural strips to an already-parsed line; `original` on a no-op.
 *
 * ⚠️ TWO SHAPES CARRY THE SAME TRANSCRIPT LINE, and this is the bug that shipped
 * in PR #11 and survived four captures (found 2026-08-05).
 *
 *   transcripts/*.jsonl  →  the raw transcript line, `type` at the TOP level.
 *   envelopes.jsonl      →  an agent-lens Envelope, whose `raw_payload` IS that
 *                           same transcript line — so `type` is one level down.
 *
 * The original strip only ever tested the top level, so every attachment body
 * captured through the collector went into `envelopes.jsonl` INTACT: 11 of them
 * across three sets, carrying `skill_listing`, `agent_listing_delta` and
 * `deferred_tools_delta` — the operator's installed inventory, verbatim. Nothing
 * caught it, because (as this config's own comment says) no scrub or detect rule
 * can recognize a skill/agent/MCP name, so `verify.mjs` exits 0 on it.
 *
 * Both strips therefore run against the top level AND against `raw_payload`.
 * Only these two positions are walked — not an arbitrary deep traversal — so
 * the transform stays predictable and auditable against a diff.
 */
function stripParsedLine(parsed, original, cfg) {
  if (parsed === null || typeof parsed !== 'object') return original;
  // Bitwise-or, not `||`: every node must be visited, not short-circuited.
  const changed = stripNode(parsed, cfg) | stripNode(parsed.raw_payload, cfg);
  return changed ? JSON.stringify(parsed) : original;
}

/** Apply both structural strips to one node in place. Returns whether it changed. */
function stripNode(node, cfg) {
  if (node === null || typeof node !== 'object') return 0;
  if (node.type === 'attachment') return stripAttachmentBody(node, cfg);
  if (node.type === 'system') return stripSystemHookCommands(node, cfg);
  return 0;
}

/** Replace an `attachment` body with `{type, stripped:true}`. Mutates in place. */
function stripAttachmentBody(node, cfg) {
  const kind = node.attachment?.type ?? null;
  const strip = cfg?.strip ?? {};
  const stripAll = strip.stripAllAttachments !== false;
  const known = strip.attachmentTypes ?? [];
  if (!stripAll && !known.includes(kind)) return 0;
  if (node.attachment?.stripped === true) return 0; // already stripped: idempotent

  node.attachment = { type: kind, stripped: true };
  return 1;
}

/**
 * Redact `hookInfos[].command` on `type:"system"` lines (Task 1.7 OQ3).
 *
 * `subtype:"stop_hook_summary"` records every hook Claude Code fired at the Stop
 * event, and each entry's `command` is the operator's registered hook line
 * verbatim — e.g. a `$SUPERSET_HOME_DIR/hooks/notify.sh` invocation. That is
 * operator environment config, the same class the attachment strip removes.
 *
 * No regex can reach it: the values are ordinary shell text with no secret
 * SHAPE, so every `detectRules` pattern scores them clean and `verify.mjs`
 * exits 0. That is precisely why the leak survived four capture sessions and a
 * standing security gate — it is a structural leak, so it needs a structural
 * strip, and this runs before the text pass for the same reason the attachment
 * strip does.
 *
 * EVERY command is redacted, including agent-lens's own `agent-lens hook`. A
 * content-based allowlist would mean auditing the redactor by reading the
 * strings it chose to keep, and the fixture already proves agent-lens ran from
 * its envelope stream rather than from this field.
 *
 * Shape is preserved: the line, the array, its length, `hookCount` and each
 * entry's `durationMs` all survive, so the transcript still exercises Phase 3's
 * tailer and the compaction set's ordering is untouched.
 *
 * `exemptSystemSubtypes` (default `compact_boundary`) is never modified — it is
 * the compaction experiment's whole payload.
 */
function stripSystemHookCommands(node, cfg) {
  const strip = cfg?.strip ?? {};
  if (strip.systemHookCommands === false) return 0;
  const exempt = strip.exemptSystemSubtypes ?? ['compact_boundary'];
  if (exempt.includes(node.subtype)) return 0;
  if (!Array.isArray(node.hookInfos)) return 0;

  const placeholder = strip.systemHookCommandPlaceholder ?? '[REDACTED-HOOK-COMMAND]';
  let changed = 0;
  for (const info of node.hookInfos) {
    if (info !== null && typeof info === 'object' && 'command' in info) {
      if (info.command === placeholder) continue; // idempotent
      info.command = placeholder;
      changed = 1;
    }
  }
  return changed;
}

/**
 * Scrub a JSONL file: strip attachment bodies structurally, then apply the same
 * regex + anonymization pass `scrubText` applies to everything else. Line count,
 * line ordering, and the presence/absence of a trailing newline are preserved,
 * so the output is still a valid transcript (and, for `envelopes.jsonl`, still
 * byte-compatible with the spool format `replaySpool` reads).
 *
 * **Throws on an unparseable line.** A torn line (a transcript copied while
 * Claude Code was mid-write) would otherwise slip through the text-only path
 * with its `attachment` body intact — and an installed skill/agent/MCP name is
 * free-form text that no scrub rule and no detect rule can recognize, so
 * verify.mjs would pass it too. Fail closed: the operator re-captures.
 *
 * @param {string} text
 * @param {Array<{regex:RegExp, replacement:string}>} rules
 * @param {{home?:string, user?:string, homePlaceholder:string, userPlaceholder:string}} anon
 * @param {object} cfg the full parsed scrub config (for the `strip` block).
 * @returns {string}
 */
export function scrubJsonl(text, rules, anon, cfg) {
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  const scrubbed = lines.map((line, index) => {
    const parsed = parseJsonLine(line);
    if (parsed === undefined && line.length > 0) {
      throw new Error(
        `line ${index + 1} is not valid JSON. A torn JSONL line bypasses the structural ` +
          'attachment strip, and no scrub or detect rule can recognize a skill/agent/MCP ' +
          'name, so the leak would survive every automated gate. Re-capture the session; ' +
          'do not hand-edit the file.',
      );
    }
    return scrubText(parsed === undefined ? line : stripParsedLine(parsed, line, cfg), rules, anon);
  });
  return scrubbed.join('\n') + (trailingNewline ? '\n' : '');
}

/** Recursively list every file under a directory (relative paths). */
export function listFiles(root) {
  const results = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else results.push(relative(root, full));
    }
  };
  walk(root);
  return results;
}

/** Parse `--flag value` pairs into a map. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (key?.startsWith('--')) args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

/** CLI entry: scrub every file from --in to --out using --config. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const inDir = args.in;
  const outDir = args.out;
  const configPath = args.config ?? join(process.cwd(), 'scrub.config.json');
  if (!inDir || !outDir) {
    process.stderr.write(
      'usage: scrub.mjs --in <raw> --out <scrubbed> [--config c] [--home h] [--user u]\n',
    );
    process.exitCode = 2;
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const rules = compileRules(config);
  const anon = {
    home: args.home,
    user: args.user,
    homePlaceholder: config.anonymize?.homePlaceholder ?? '/home/USER',
    userPlaceholder: config.anonymize?.userPlaceholder ?? 'USER',
  };

  const files = listFiles(inDir);
  for (const rel of files) {
    const raw = readFileSync(join(inDir, rel), 'utf8');
    // JSONL gets the structural attachment strip first; everything else
    // (manifest.json, tool-results/*.txt) is a flat text pass as before.
    let scrubbed;
    try {
      scrubbed = rel.endsWith('.jsonl')
        ? scrubJsonl(raw, rules, anon, config)
        : scrubText(raw, rules, anon);
    } catch (err) {
      process.stderr.write(`scrub: ${rel}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const dest = join(outDir, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, scrubbed);
  }
  process.stdout.write(
    `scrubbed ${files.length} file(s) -> ${outDir}\n` +
      `NEXT: node verify.mjs --dir ${outDir} --home "$HOME" --user "$USER"\n` +
      'MANUAL EYEBALL GATE STILL REQUIRED before commit (see SCRUBBING.md)\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
