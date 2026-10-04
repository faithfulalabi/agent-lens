import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESIGN_SYSTEM_EXCERPT,
  FIRST_RUN_EXCERPT,
  INSPECT_SESSION_EXCERPT,
  PUBLISHED_LINES,
  REDACTION_MARKER,
} from './spec-excerpt';
import {
  EXCERPT_LABEL,
  SPEC_ROOT_CANDIDATES,
  designSystemExists,
  designSystemSource,
  parseColourFence,
  resolveSpecRoot,
  userFlowPath,
  userFlowSource,
} from './spec-doc';
import { SPEC_TOKENS } from '../design/spec-tokens';
import { emptyStateCopy } from '../lib/session-list';
import { DEAD_PRODUCT_TERMS } from '../../../src/__tests__/dead-product-terms';

/*
 * Drives the excerpt's read paths directly, in-process, on every run — so the
 * fallback branch can never first break in an environment without the spec.
 */

/** The window `session-list.test.tsx`'s `emptyStatesSpec()` computes, verbatim. */
function emptyStatesWindow(lines: readonly string[]): string {
  const heading = lines.findIndex((line) => line.trim() === '### Empty states');
  expect(heading, 'no Empty states section').toBeGreaterThan(-1);
  const next = lines.findIndex((line, i) => i > heading && line.startsWith('### '));
  return lines.slice(heading, next === -1 ? undefined : next).join('\n');
}

describe('the published excerpt satisfies every read path the parity tests use', () => {
  it('parses the full colour-token set out of the excerpt alone', () => {
    const tokens = parseColourFence(DESIGN_SYSTEM_EXCERPT, EXCERPT_LABEL);
    // An exact count, not "> 0", so a fence that silently lost a token reds.
    expect(tokens.size).toBe(20);
    expect(tokens.get('--color-background')).toBe('#0b0b0e');
    expect(tokens.get('--color-running')).toBe('#7c8cf8');
  });

  it('every one of the 41 prose pins lands on its own specLine', () => {
    // Keeps the index alignment honest: a dropped line shifts every pin below it.
    expect(SPEC_TOKENS.length).toBe(41);
    const distinct = new Set(SPEC_TOKENS.map((t) => t.specLine));
    expect(distinct.size).toBe(33);

    for (const token of SPEC_TOKENS) {
      const line = DESIGN_SYSTEM_EXCERPT[token.specLine - 1];
      expect(line, `excerpt has no line ${token.specLine} (for ${token.cssVar})`).toBeDefined();
      expect(
        line,
        `excerpt line ${token.specLine} no longer states ${token.cssVar}'s value.\n` +
          `  expected to find: ${token.prosePin}\n` +
          `  line reads:       ${line}`,
      ).toContain(token.prosePin);
    }
  });

  it('the Empty states window carries all four pinned copy strings', () => {
    const spec = emptyStatesWindow(DESIGN_SYSTEM_EXCERPT);
    const neverCaptured = emptyStateCopy({ kind: 'never_captured' });
    expect(spec).toContain(neverCaptured.sentence);
    expect(spec).toContain('outside range');

    // The fourth state. Named individually: all three strings sit on one line, so
    // a single assertion would cover them by luck rather than by design.
    const fourth = emptyStateCopy({
      kind: 'no_match_for_project',
      project: '/p/one',
      count: 12,
      truncated: false,
    });
    expect(spec).toContain('in this range across all projects.');
    expect(spec).toContain('{project}');
    expect(spec).toContain(fourth.hint);
  });

  it('the populated-list count sentence survives the redaction', () => {
    const whole = DESIGN_SYSTEM_EXCERPT.join('\n');
    expect(whole).toContain('**"N sessions"**');
    expect(whole).toContain('"1 session"');
    expect(whole).toContain('**"N+ sessions"**');
  });

  it('both flow excerpts carry their pinned copy, and neither is empty', () => {
    const { sentence, hint } = emptyStateCopy({ kind: 'never_captured' });
    expect(FIRST_RUN_EXCERPT.length).toBeGreaterThan(0);
    expect(INSPECT_SESSION_EXCERPT.length).toBeGreaterThan(0);
    expect(FIRST_RUN_EXCERPT).toContain(sentence);
    expect(hint).toContain('agent-lens doctor');
    expect(INSPECT_SESSION_EXCERPT).toContain('agent-lens doctor');
    expect(INSPECT_SESSION_EXCERPT).toContain('outside range');
  });

  it('keeps Flow 3\'s losing "outside this range" spelling out of the pin', () => {
    // The excerpt publishes both spellings, so the pin must tell them apart.
    const { sentence } = emptyStateCopy({ kind: 'outside_range', count: 7, truncated: false });
    expect(sentence).not.toContain('outside this range');
    expect(emptyStatesWindow(DESIGN_SYSTEM_EXCERPT)).not.toContain('outside this range');
  });
});

describe('the redaction marker cannot collide with a structural landmark', () => {
  it('holds all five marker conditions', () => {
    // A marker colliding with a landmark would move a window while the assertions
    // still "passed" against the wrong text.
    expect(REDACTION_MARKER.trim(), 'would open the css fence above :62').not.toBe('```css');
    expect(REDACTION_MARKER.trim(), 'would close the css fence early').not.toBe('```');
    expect(REDACTION_MARKER.startsWith('### '), 'would truncate the Empty states window').toBe(
      false,
    );
    expect(REDACTION_MARKER.trim(), 'would be found as the Empty states heading').not.toBe(
      '### Empty states',
    );
    for (const token of SPEC_TOKENS) {
      expect(
        REDACTION_MARKER,
        `marker carries ${token.cssVar}'s prosePin, which would mask a line shift`,
      ).not.toContain(token.prosePin);
    }
  });

  it('is what every unpublished line reads, and the published ranges are intact', () => {
    const published = new Set<number>();
    for (const [from, to] of PUBLISHED_LINES.designSystem) {
      for (let n = from; n <= to; n += 1) published.add(n);
    }
    expect(DESIGN_SYSTEM_EXCERPT.length).toBe(179);

    for (const [index, line] of DESIGN_SYSTEM_EXCERPT.entries()) {
      const lineNumber = index + 1;
      if (published.has(lineNumber)) continue;
      expect(line, `design-system.md:${lineNumber} is not published and must be the marker`).toBe(
        REDACTION_MARKER,
      );
    }

    expect(DESIGN_SYSTEM_EXCERPT.slice(0, 61).every((l) => l === REDACTION_MARKER)).toBe(true);
    expect(DESIGN_SYSTEM_EXCERPT.join('\n')).not.toContain('consented');
  });
});

describe('the committed excerpt documents no product that was deleted', () => {
  it('the hit set is empty over all three exports', () => {
    // `docs.test.ts` scans a hard-coded list of docs and will never reach this
    // module, so the same term map is re-run here.
    const sources: ReadonlyArray<readonly [string, string]> = [
      ['spec-excerpt.ts DESIGN_SYSTEM_EXCERPT', DESIGN_SYSTEM_EXCERPT.join('\n')],
      ['spec-excerpt.ts FIRST_RUN_EXCERPT', FIRST_RUN_EXCERPT],
      ['spec-excerpt.ts INSPECT_SESSION_EXCERPT', INSPECT_SESSION_EXCERPT],
    ];
    const hits: string[] = [];
    for (const [name, text] of sources) {
      text.split('\n').forEach((line, index) => {
        for (const [term, pattern] of DEAD_PRODUCT_TERMS) {
          if (pattern.test(line)) hits.push(`${name}:${index + 1}  ${term}  ${line.trim()}`);
        }
      });
    }
    expect(
      hits,
      'Hooks are gone. A committed spec excerpt that still names the harness ' +
        'settings file, an installer, an uninstaller or a hook event is ' +
        'publishing a product that no longer exists.',
    ).toEqual([]);
  });
});

describe('the spec root resolves in both on-disk layouts, and the excerpt answers neither', () => {
  /** A throwaway spec tree at `<root>/<nesting>/spec/`, written to a temp dir. */
  function fakeSpec(nesting: readonly string[]): { root: string; candidates: string[] } {
    const base = mkdtempSync(join(tmpdir(), 'agent-lens-spec-'));
    const specDir = join(base, ...nesting, 'spec');
    mkdirSync(join(specDir, 'user-flows'), { recursive: true });
    writeFileSync(join(specDir, 'design-system.md'), 'marker-from-disk\n```css\n--x: #abc;\n```\n');
    writeFileSync(join(specDir, 'user-flows', '01-first-run-install.md'), 'flow-1-from-disk\n');
    writeFileSync(join(specDir, 'user-flows', '03-inspect-session.md'), 'flow-3-from-disk\n');
    return {
      root: base,
      candidates: [join(base, 'spec') + '/', join(base, 'agent-lens', 'spec') + '/'],
    };
  }

  it.each([
    ['the founder symlink layout (internal_docs/spec)', [] as const],
    ['the CI tar layout (internal_docs/agent-lens/spec)', ['agent-lens'] as const],
  ])('resolves %s', (_label, nesting) => {
    const { candidates } = fakeSpec(nesting);
    expect(resolveSpecRoot(candidates)).not.toBeNull();

    const source = designSystemSource(candidates);
    expect(source.origin).toBe('spec');
    expect(source.lines[0]).toBe('marker-from-disk');
    expect(parseColourFence(source.lines, source.label).get('--color-x')).toBe('#abc');

    expect(userFlowSource('firstRun', candidates).lines.join('\n')).toContain('flow-1-from-disk');
    expect(userFlowSource('inspectSession', candidates).lines.join('\n')).toContain(
      'flow-3-from-disk',
    );
  });

  it('falls back to the excerpt only when no candidate root exists', () => {
    const absent = [join(tmpdir(), 'agent-lens-no-such-spec-root', 'spec') + '/'];
    expect(resolveSpecRoot(absent)).toBeNull();
    expect(designSystemExists(absent)).toBe(false);

    const source = designSystemSource(absent);
    expect(source.origin).toBe('excerpt');
    expect(source.label).toBe(EXCERPT_LABEL);
    expect(source.lines).toBe(DESIGN_SYSTEM_EXCERPT);
    expect(userFlowSource('firstRun', absent).origin).toBe('excerpt');
    expect(userFlowSource('inspectSession', absent).origin).toBe('excerpt');
  });

  it('never throws while building a failure message, even with no spec at all', () => {
    // Callers evaluate `userFlowPath()` eagerly to build a failure message, so a
    // throw here would surface as a stack under an unrelated assertion.
    const absent = [join(tmpdir(), 'agent-lens-no-such-spec-root', 'spec') + '/'];
    expect(() => userFlowPath('firstRun', absent)).not.toThrow();
    expect(userFlowPath('firstRun', absent)).toContain('01-first-run-install.md');
  });

  it('offers the two real layouts, in the order that makes the symlink win', () => {
    expect(SPEC_ROOT_CANDIDATES.length).toBe(2);
    expect(SPEC_ROOT_CANDIDATES[0]).toMatch(/internal_docs\/spec\/$/);
    expect(SPEC_ROOT_CANDIDATES[1]).toMatch(/internal_docs\/agent-lens\/spec\/$/);
  });
});

/*
 * Drift. Runs only where the real spec is on disk. It prints the corrected line
 * and writes nothing: a writer here would race the other vitest workers reading
 * the same module.
 */
describe.runIf(designSystemExists())('the excerpt still matches the real spec', () => {
  it('publishes every design-system line byte-identically', () => {
    const real = designSystemSource().lines;
    expect(designSystemSource().origin).toBe('spec');

    const drift: string[] = [];
    for (const [from, to] of PUBLISHED_LINES.designSystem) {
      for (let n = from; n <= to; n += 1) {
        const published = DESIGN_SYSTEM_EXCERPT[n - 1];
        const truth = real[n - 1];
        if (published !== truth) {
          drift.push(
            `design-system.md:${n}\n  excerpt: ${published}\n  spec:    ${truth}\n` +
              `  fix spec-excerpt.ts line ${n} to: ${JSON.stringify(truth)}`,
          );
        }
      }
    }
    expect(
      drift,
      'The real spec moved. Hand-edit `spec-excerpt.ts` to the lines printed ' +
        'above — there is no generator, deliberately.',
    ).toEqual([]);
  });

  it('lands the fence and the Empty states window on the same text in both', () => {
    const real = designSystemSource().lines;
    expect(Object.fromEntries(parseColourFence(DESIGN_SYSTEM_EXCERPT, EXCERPT_LABEL))).toEqual(
      Object.fromEntries(parseColourFence(real, 'real spec')),
    );
    expect(emptyStatesWindow(DESIGN_SYSTEM_EXCERPT)).toBe(emptyStatesWindow(real));
  });

  it.each([
    ['firstRun', FIRST_RUN_EXCERPT, PUBLISHED_LINES.firstRun] as const,
    ['inspectSession', INSPECT_SESSION_EXCERPT, PUBLISHED_LINES.inspectSession] as const,
  ])('publishes every %s line byte-identically', (name, excerpt, published) => {
    const real = userFlowSource(name).lines;
    const drift: string[] = [];
    for (const n of published) {
      const truth = real[n - 1];
      // Prose pins, so the invariant is presence of the real line, not position.
      if (truth === undefined || !excerpt.includes(truth)) {
        drift.push(`${name} line ${n} is no longer published verbatim:\n  spec: ${truth}`);
      }
    }
    expect(drift).toEqual([]);
  });
});
