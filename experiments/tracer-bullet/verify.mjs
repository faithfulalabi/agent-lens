// The verification gate — the independent cross-check that stands between a
// scrubbed fixture set and `git add`. It replaces the hand-copied shell greps
// that SCRUBBING.md:59-65 used to carry: those were a *different, looser* copy
// of scrub.config.json's patterns, and the drift was the defect — the copy had
// no length quantifier, so `sk-b` inside `task-break` failed the gate on every
// fixture that mentioned one of this repo's own task names.
//
// The fix is NOT "reuse the scrub rules". That would make the gate return zero
// by construction — a tautology that cannot catch the failure mode that
// actually matters (a scrub rule tightened past a real secret). Instead
// scrub.config.json carries a second, deliberately LOOSER `detectRules` set
// that only this file compiles. One file, one source of truth, but the
// detector is not the redactor. Expect detectRules to occasionally flag
// something scrubText leaves alone; each hit is triaged at the eyeball gate.
//
// Run: node verify.mjs --dir fixtures/scrubbed [--config scrub.config.json] \
//        [--home "$HOME"] [--user "$USER"]
// Exits 1 on any hit (so it works as a `&&` gate), 0 when clean.
// Importable: `import { verifyText, verifyDir } from "./verify.mjs"`.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { compileRules, listFiles, parseArgs } from './scrub.mjs';

/**
 * @typedef {object} Hit
 * @property {string} [file] repo/scan-relative path (set by verifyDir).
 * @property {number} line 1-based line number.
 * @property {string} rule the detectRules rule name that fired.
 * @property {string} match the offending substring.
 */

/**
 * Scan one string with the compiled detect rules plus the raw home/user
 * strings. Line-oriented so every hit can be reported as `file:line:rule`,
 * which is what makes the eyeball gate actionable.
 *
 * `anon.home` / `anon.user` are the operator's REAL values — a residual
 * occurrence means the anonymization pass missed a spelling, which no regex
 * rule can know about.
 *
 * @param {string} text
 * @param {Array<{name:string, regex:RegExp}>} rules
 * @param {{home?:string, user?:string}} [anon]
 * @returns {Hit[]}
 */
export function verifyText(text, rules, anon = {}) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of rules) {
      // Compiled rules are global; reset lastIndex so a shared RegExp cannot
      // skip a hit on the next line it is applied to.
      rule.regex.lastIndex = 0;
      for (const match of line.matchAll(rule.regex)) {
        hits.push({ line: i + 1, rule: rule.name, match: match[0] });
      }
    }
    if (anon.home && line.includes(anon.home)) {
      hits.push({ line: i + 1, rule: 'residual-home-dir', match: anon.home });
    }
    if (anon.user && line.includes(anon.user)) {
      hits.push({ line: i + 1, rule: 'residual-username', match: anon.user });
    }
  }
  return hits;
}

/**
 * Scan every file under a directory. A missing directory is zero hits, not an
 * error: the standing gate runs on every `npm test`, including before any
 * fixture has been captured. Set completeness is asserted separately.
 *
 * @param {string} dir
 * @param {Array<{name:string, regex:RegExp}>} rules
 * @param {{home?:string, user?:string}} [anon]
 * @returns {Hit[]}
 */
export function verifyDir(dir, rules, anon = {}) {
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const rel of listFiles(dir)) {
    const text = readFileSync(join(dir, rel), 'utf8');
    for (const hit of verifyText(text, rules, anon)) {
      hits.push({ file: rel, ...hit });
    }
  }
  return hits;
}

/** Render one hit as `file:line:rule: match` (truncated), the gate's report line. */
export function formatHit(hit) {
  const snippet = hit.match.length > 60 ? `${hit.match.slice(0, 57)}...` : hit.match;
  return `${hit.file ?? '<stdin>'}:${hit.line}:${hit.rule}: ${snippet}`;
}

/** CLI entry: scan --dir with the config's detectRules; exit 1 on any hit. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = args.config ?? join(here, 'scrub.config.json');
  if (!dir) {
    process.stderr.write('usage: verify.mjs --dir <scrubbed> [--config c] [--home h] [--user u]\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(dir)) {
    process.stderr.write(`verify: no such directory: ${dir}\n`);
    process.exitCode = 2;
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const rules = compileRules(config, 'detectRules');
  const hits = verifyDir(dir, rules, { home: args.home, user: args.user });

  if (hits.length === 0) {
    process.stdout.write(`verify: 0 hits under ${dir} (${rules.length} detect rules)\n`);
    return;
  }
  for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
  process.stderr.write(
    `verify: ${hits.length} hit(s) under ${dir} — triage every one before committing (SCRUBBING.md)\n`,
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
