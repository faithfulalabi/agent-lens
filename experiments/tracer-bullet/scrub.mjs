// The scrubber — the mandatory gate between raw captures and committed
// fixtures. Data-model classifies raw payloads as sensitive (may echo secrets),
// so nothing under fixtures/raw/ may ever be committed. This pass reads a raw
// capture directory, applies the deterministic rules in scrub.config.json plus
// home-dir/username anonymization, and writes shape-preserving output to
// fixtures/scrubbed/. It is deterministic (same input -> same output) and
// preserves JSON structure and Q3 size markers so scrubbed fixtures still
// replay through /api/ingest unchanged. A manual eyeball gate (SCRUBBING.md)
// is STILL required afterward — this tool reduces risk, it does not eliminate
// the "assume worst" posture.
//
// Run: node scrub.mjs --in fixtures/raw/<exp> --out fixtures/scrubbed/<exp> \
//        --config scrub.config.json --home "$HOME" --user "$USER"
// Importable: `import { compileRules, scrubText } from "./scrub.mjs"`.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

/**
 * Compile the JSON config's string patterns into RegExp objects. A leading
 * `(?i)` inline flag is honored (JS lacks inline flags) by lifting it to the
 * `i` flag. All rules are global. Throws on an invalid pattern so a broken
 * config fails loud rather than silently under-redacting.
 *
 * @param {{rules: Array<{name:string, pattern:string, replacement:string}>}} config
 * @returns {Array<{name:string, regex:RegExp, replacement:string}>}
 */
export function compileRules(config) {
  return config.rules.map((rule) => {
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

/** Recursively list every file under a directory (relative paths). */
function listFiles(root) {
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
function parseArgs(argv) {
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
    const scrubbed = scrubText(raw, rules, anon);
    const dest = join(outDir, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, scrubbed);
  }
  process.stdout.write(
    `scrubbed ${files.length} file(s) -> ${outDir}\nMANUAL EYEBALL GATE REQUIRED before commit (see SCRUBBING.md)\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
