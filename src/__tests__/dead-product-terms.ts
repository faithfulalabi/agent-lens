/**
 * The dead-install-path vocabulary, in one place because two suites gate on it.
 *
 * `docs.test.ts` runs it over `PUBLIC_DOCS` (README, SECURITY, CONTRIBUTING).
 * `ui/src/__tests__/spec-excerpt.test.ts` runs the same map over the published
 * spec excerpt, which `PUBLIC_DOCS` will never scan because that list is a
 * hard-coded three-element array. Task 1.1 committed an excerpt of the spec, and
 * the spec's Flow 1 documents the deleted hooks product end to end — so the
 * excerpt needs the identical gate or the terms re-enter the tracked tree
 * through a door the original gate does not watch.
 *
 * It lives in a plain module rather than being exported from `docs.test.ts`
 * because importing a vitest test file re-registers every `describe` in it
 * inside the importing project's run.
 *
 * Scoped to AC3's literal words. `installer` and `uninstall` are anchored so they
 * never match the `npm install` CONTRIBUTING.md legitimately documents. Do not
 * weaken a term.
 */
export const DEAD_PRODUCT_TERMS: ReadonlyMap<string, RegExp> = new Map([
  ['settings.json', /settings\.json/],
  ['installer', /\binstallers?\b/i],
  ['uninstall', /\buninstall\w*\b/i],
  ['consent', /\bconsents?\b|\bconsented\b/i],
  ['PreToolUse', /\bPreToolUse\b/],
  ['PostToolUse', /\bPostToolUse\b/],
  ['SessionStart', /\bSessionStart\b/],
  ['agent-lens hook', /agent-lens hook/],
]);

/** `name:line  term  text` for every hit, so a failure says where to look. */
export function deadProductHits(name: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const [term, pattern] of DEAD_PRODUCT_TERMS) {
      if (pattern.test(line)) hits.push(`${name}:${index + 1}  ${term}  ${line.trim()}`);
    }
  });
  return hits;
}
