// "Is this a person talking?" — the question plan 001 never asked, which is how
// it shipped a session list where 17 of 25 "turns" were machinery. This is the
// highest-drift-risk heuristic in the product, so it is one file, one exported
// verdict, and a fallback that can be scored against a machine-checkable oracle.
//
// ★ `kind === 'user'` is the FIRST clause of BOTH paths, and there is only one
// copy of it in each so they cannot drift. Measured against
// `~/.agent-lens/archive` on 2026-08-13: with every other clause applied but
// this one absent, 1,149 `type:"assistant"` lines score human against an oracle
// of 90 — a 12.8x overcount. Real examples: "No response requested.",
// "I'll take a look at what's going on with your Desktop directory." With the
// guard the assistant population is 0 and the whole archive yields 92
// detections: the 90 oracle humans plus the two typed `/compact` invocations,
// which carry no `origin` and which this module calls human.
//
// `origin` is NOT a harness-version property, whatever the RFC says. It is
// absent from ~60% of user-text lines today, because its presence tracks
// interactive submission. The fallback is therefore the PRIMARY path, not a
// legacy compatibility path.
//
// Pure, and total by construction: every field is read through
// `./accessors.js`, so this module declares no `try`/`catch` of its own.

import { obj, str } from './accessors.js';
import { classifyContent } from './blocks.js';
import type { ParsedLine } from './line.js';

/** Why a line was called human or machinery, and which path decided it. */
export interface HumanVerdict {
  readonly human: boolean;
  readonly path: 'kind' | 'origin' | 'fallback';
  /** The clause that decided, so a wrong verdict traces to one line of code. */
  readonly reason: string;
}

/**
 * Harness tags measured in LEADING position. Only the first five occur there
 * today (143 / 30 / 14 / 14 / 13); the rest are recorded because the measurement
 * found them and a reader deserves the inventory.
 *
 * Every name here also matches the generic rule below, so no input exists where
 * this list flips a verdict on its own. It is kept as documentation of intent
 * and as the floor that survives anyone narrowing that regex.
 */
export const MACHINERY_TAGS: readonly string[] = [
  '<task-notification>',
  '<command-message>',
  '<local-command-caveat>',
  '<command-name>',
  '<local-command-stdout>',
  '<command-args>',
  '<local-command-stderr>',
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  '<bash-input>',
  '<bash-stdout>',
];

/** Openers the harness writes into `message.content` on a user's behalf. */
export const MACHINERY_PREFIXES: readonly string[] = [
  '[Request interrupted',
  'Caveat: The messages below',
  'This session is being continued',
  'API Error',
];

/** Any leading `<tag>`, so an unmeasured harness tag is machinery on day one. */
const LEADING_TAG = /^<[a-z][a-z0-9-]*>/;

/**
 * ★ The fallback's ONE text source: the line's top-level `text` blocks, joined.
 * Never `tool_result` content, never nested blocks.
 *
 * `tool_result.content` is a bare string 13,144 times, and folding that text in
 * scores 2,028 `user` lines human against an oracle of 90 — a 22.5x overcount.
 * A bare-string `message.content` needs no special case here: `normalizeContent`
 * has already turned it into one top-level `text` block.
 */
function promptText(line: ParsedLine): string {
  return classifyContent(obj(line.raw.message, undefined)?.content)
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function startsWithMachineryTag(text: string): boolean {
  return MACHINERY_TAGS.some((tag) => text.startsWith(tag)) || LEADING_TAG.test(text);
}

/**
 * `''` when the line passes every clause; otherwise the clause that refused it.
 * The single implementation of the conjunction — `fallbackIsHuman` and
 * `isHumanPrompt` both read this, so the boolean and the reason cannot disagree.
 */
function fallbackRejection(line: ParsedLine): string {
  if (line.kind !== 'user') return 'not-a-user-line';
  // No `bool()` accessor exists, deliberately: `=== true` is the whole check.
  if (line.raw.isSidechain === true) return 'sidechain';
  if (line.raw.isMeta === true) return 'meta';
  if (line.raw.isCompactSummary === true) return 'compact-summary';

  const text = promptText(line);
  if (text === '') return 'no-text';
  if (startsWithMachineryTag(text)) return 'machinery-tag';

  const prefix = MACHINERY_PREFIXES.find((opener) => text.startsWith(opener));
  return prefix === undefined ? '' : `machinery-prefix:${prefix}`;
}

/**
 * The fallback conjunction alone, exported so the golden scorer can score IT
 * rather than the composite. Scoring `isHumanPrompt` on the origin-present
 * population is a tautology — it returns the oracle verbatim there.
 *
 * `kind === 'user'` is its own first clause and not merely the caller's guard:
 * scored standalone over the whole archive without it, this predicate answers
 * `true` on 1,149 assistant lines.
 */
export function fallbackIsHuman(line: ParsedLine): boolean {
  return fallbackRejection(line) === '';
}

/**
 * Is this line a person talking? `origin` decides where it is readable, in BOTH
 * directions — any kind other than `human` is machinery, which is how the
 * undocumented `coordinator` kind needs no branch. An `origin` whose `kind` is
 * not a string is no origin at all, and falls through to the fallback.
 */
export function isHumanPrompt(line: ParsedLine): HumanVerdict {
  if (line.kind !== 'user') return { human: false, path: 'kind', reason: 'not-a-user-line' };

  const originKind = str(obj(line.raw.origin, undefined)?.kind, undefined);
  if (originKind !== undefined) {
    return { human: originKind === 'human', path: 'origin', reason: `origin:${originKind}` };
  }

  const rejection = fallbackRejection(line);
  return {
    human: rejection === '',
    path: 'fallback',
    reason: rejection === '' ? 'prose' : rejection,
  };
}
