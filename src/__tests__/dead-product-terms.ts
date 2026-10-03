/**
 * Dead install-path vocabulary, shared by two suites. A plain module, not a test
 * export — importing a test file re-registers its `describe`s. The `installer`
 * and `uninstall` anchors keep `npm install` from matching.
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
