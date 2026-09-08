// The binary-wide unknown-argument guard. It generalises `parsePruneArgs`
// (`commands/prune.ts:90-118`) from the one destructive command to all six, and
// it runs in `main` BEFORE dispatch — which is the only way `agent-lens start
// --bogus` can be refused without first binding a socket.
//
// ★ THE ONE RULE THAT MAKES IT SAFE: a `value` flag's value is consumed BY
// POSITION and never inspected (`prune.ts:106`). Project slugs are path-derived
// and begin with `-` (`commands/archive.ts:40-43`), so a validator that judged
// what "looks like" a value would refuse `--dataDir -Users-x-proj`. It also
// means `--dataDir --verify` is accepted and `--verify` stays true, matching the
// swallow `parseStringFlag` already performs (`__tests__/doctor.test.ts:54-55`).
// The validator agrees with the parsers; it does not out-think them.
//
// ★ IT DECLARES NO EXIT CODE, AND IMPORTS NOTHING. `commands/archive.ts:1-31`
// is the single authoritative statement of this binary's three codes, and
// `index.ts` returns the bare literal `1` for the same reason it already does on
// the unknown-command path: importing the constant from `commands/archive.ts`
// would statically pull the archive graph into every invocation and break the
// lazy-import rule at `index.ts:15-18`.

/** `value` consumes the next argv token; `boolean` does not. */
export type FlagKind = 'value' | 'boolean';

export interface ArgSpec {
  name: string;
  /** Every flag this command reads. Anything else is refused. */
  flags: Record<string, FlagKind>;
  /**
   * Where a bare (non-`--`) argument may sit. A POSITION, not a count, because
   * the two commands that take one disagree about where it may go:
   *   'none'     — no bare argument at all
   *   'first'    — one, and only at index 0. `parseSessionId`
   *                (`commands/rebuild.ts:33-36`) reads `args[0]` and nothing
   *                else, and dropping the id takes the whole-cache branch.
   *   'anywhere' — one, at any index, as `parsePruneArgs` accepts.
   */
  positional: 'none' | 'first' | 'anywhere';
}

export type ArgsResult = { ok: true } | { ok: false; message: string };

/** Lowercase and drop the separators people guess wrong: `--data-dir` → `datadir`. */
function normalise(flag: string): string {
  return flag.toLowerCase().replace(/[-_]/g, '');
}

/**
 * The flag a mistyped one meant, or nothing. ONLY an exact normalised match
 * qualifies — no edit distance, so a WRONG suggestion is impossible by
 * construction rather than by tuning.
 */
function didYouMean(spec: ArgSpec, name: string): string | undefined {
  const target = normalise(name);
  return Object.keys(spec.flags).find((known) => normalise(known) === target);
}

/** Refuses anything `spec` does not name, walking argv as the parsers do. */
export function validateArgs(spec: ArgSpec, args: string[]): ArgsResult {
  let seenPositional = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const kind = spec.flags[name];
      if (kind === undefined) {
        const meant = didYouMean(spec, name);
        return {
          ok: false,
          message: `unknown argument ${arg}${meant === undefined ? '' : ` — did you mean ${meant}?`}`,
        };
      }
      if (kind === 'boolean') continue;
      if (eq === -1) {
        // `--flag value`: consume by position, whatever the token is. An
        // explicitly empty one (`--port ''`) reaches the parser unchanged.
        if (i + 1 >= args.length) return { ok: false, message: `${name} requires a value` };
        i += 1;
        continue;
      }
      // `--flag=`: the parsers' own wording (`archive.ts:51,56`, `start.ts:41`).
      if (eq === arg.length - 1) return { ok: false, message: `${name} requires a value` };
      continue;
    }

    if (spec.positional === 'none') {
      return { ok: false, message: `unexpected argument ${arg}` };
    }
    // "At most one" is checked first so a SECOND bare id gets the count message
    // rather than the placement one, which would not describe its problem.
    if (seenPositional) {
      return {
        ok: false,
        message: `unexpected argument ${arg} — ${spec.name} takes at most one session id`,
      };
    }
    if (spec.positional === 'first' && i !== 0) {
      return {
        ok: false,
        message: `unexpected argument ${arg} — ${spec.name} takes [session-id] first, before any flag`,
      };
    }
    seenPositional = true;
  }
  return { ok: true };
}
