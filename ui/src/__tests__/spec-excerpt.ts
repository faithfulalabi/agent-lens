/*
 * The published spec excerpt — the fallback source for the parity tests when
 * `internal_docs/` is absent (a fork PR, a fresh clone, trusted CI).
 *
 * WHY THIS FILE EXISTS. The parity tests read specification documents that live
 * in `internal_docs/`, which is git-ignored by design. Before this module, CI
 * provisioned them from a repo secret — and GitHub never exposes secrets to a
 * `pull_request` run from a fork, so an outside contributor's first PR could not
 * go green. Committing a line-faithful excerpt makes the parity tests satisfiable
 * everywhere with no secret at all. Task 1.1.
 *
 * WHAT IS PUBLISHED, EXACTLY (founder ruling 2026-09-30, which supersedes the
 * 2026-09-16 "spec provisioning = repo secret" ruling):
 *   - `design-system.md` lines 62-129, 169-179 — the colour fence, the token
 *     tables, the session-list count sentence and the Empty states section.
 *     ZERO of `:1-61`, which is where the aesthetic references live.
 *   - `01-first-run-install.md:14` — the binding spelling of the
 *     never-captured sentence, and nothing else. Every other line of Flow 1 is
 *     redacted, which is what keeps the deleted hooks product out of the tracked
 *     tree by construction.
 *   - `03-inspect-session.md:24,35,50` — the `agent-lens doctor` hint and the
 *     "outside range" diagram node.
 * Everything else is `REDACTION_MARKER`. The real spec still WINS when present:
 * `spec-doc.ts` resolves it first and only falls back to these exports.
 *
 * THE MARKER IS LOAD-BEARING, NOT COSMETIC. Every read path over this data is a
 * structural search, so a marker that collided with a landmark would silently
 * move a window while the assertions still "passed" against the wrong text. The
 * marker must not trim to ```css (it would open the fence above :62), must not
 * trim to ``` (it would close it early), must not start with '### ' and must not
 * equal '### Empty states' (either truncates the Empty-states window), and must
 * carry no `prosePin` (which would mask a genuine line shift). Pinned by
 * `spec-excerpt.test.ts`, five assertions, one `it`.
 *
 * NO DEAD-PRODUCT PROSE MAY ENTER HERE. `docs.test.ts`'s `PUBLIC_DOCS` is a
 * hard-coded three-element list and will never scan this module, so its `TERMS`
 * map is re-run over all three exports by `spec-excerpt.test.ts`. That assertion
 * is the gate, not a side effect: it must red if a future line is added back.
 *
 * HOW TO EDIT. By hand, one line at a time, against the real spec — there is no
 * generator and there must not be one. `golden-replay.test.ts` records why: an
 * earlier regeneration script permanently disarmed an anti-skip gate for anyone
 * who ran it once. The founder-only drift test in `spec-excerpt.test.ts` PRINTS
 * the corrected line and writes nothing. A malformed excerpt is a compile error,
 * so `npm run typecheck` catches it before vitest starts.
 */

/** Stands in for every line of the spec that is deliberately not published. */
export const REDACTION_MARKER = '<!-- redacted -->';

/**
 * `design-system.md` lines 1-179, 1:1 by index: element `i` is line `i + 1`.
 *
 * A `string[]` rather than one template literal because lines 62 and 90 are
 * triple backticks, which would terminate the literal. The index alignment is
 * what `spec-tokens.ts`'s `specLine` pins resolve against — `tsc` checks the
 * array, so a dropped line is a type-level length change, not a silent shift.
 */
export const DESIGN_SYSTEM_EXCERPT: readonly string[] = [
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '```css', // :62
  '/* Neutrals — surfaces & text (dark-only v1) */', // :63
  '--background: #0b0b0e; /* app canvas */', // :64
  '--surface: #131318; /* panels, cards, rows */', // :65
  '--surface-raised: #1b1b22; /* hover, selected row, popovers */', // :66
  '--border: #26262e; /* hairline separation — borders, not shadows */', // :67
  '--foreground: #ededf0; /* primary text */', // :68
  '--muted: #9b9ba6; /* secondary text, chip labels */', // :69
  '--faint: #5c5c66; /* tertiary: timestamps, placeholders */', // :70
  '', // :71
  '/* Brand accent — interactive elements only (links, focus, primary buttons, live badge) */', // :72
  '--accent: #7c8cf8; /* indigo 400-ish; calm, not neon */', // :73
  '--accent-hover: #97a3fa;', // :74
  '--accent-muted: #7c8cf826; /* 15% — selection washes, focus rings */', // :75
  '', // :76
  "/* Span-type palette — icons, tree chips, thread cards (the product's vocabulary) */", // :77
  '--span-turn: #2dd4bf; /* teal    — turn/agent-step spans */', // :78
  '--span-llm: #c084fc; /* violet  — LLM calls */', // :79
  '--span-tool: #60a5fa; /* blue    — tool calls */', // :80
  '--span-subagent: #818cf8; /* indigo  — sub-agent groups */', // :81
  '--span-thinking: #9b9ba6; /* gray    — thinking (deliberately quiet) */', // :82
  '--span-generic: #a3e635; /* lime    — generic/foreign spans (render-only evals concession) */', // :83
  '', // :84
  '/* Semantic status */', // :85
  '--success: #4ade80; /* complete, ok */', // :86
  '--warning: #fbbf24; /* degraded capture, interrupted, drift banner */', // :87
  '--error: #f87171; /* failed/denied spans, dead-letter banner */', // :88
  '--running: #7c8cf8; /* in-progress — accent-colored pulse, not a semantic alarm */', // :89
  '```', // :90
  '', // :91
  "Rationale: the mockups' read—dark canvas, pastel-saturated type icons—is kept, but disciplined: **neutrals carry the layout, span-type colors carry meaning, the accent only marks interactivity.** Nothing else gets color, so a red span is findable in a 5,000-row tree at a glance (P1-11).", // :92
  '', // :93
  '### Typography', // :94
  '', // :95
  '- **Body/UI:** **Inter** (self-hosted, variable) — 13px base for chrome/tree/tables, 14px for reading surfaces (thread view, detail prose).', // :96
  "- **Mono:** **JetBrains Mono** (self-hosted) — all technical values: IDs, durations, token counts, costs, file paths, JSON, code. In this product mono is ~40% of rendered text; it's a first-class citizen, not an accent.", // :97
  '- **Display:** none — Inter semibold at 16–20px is the largest text in the app. Trace tools have no heroes.', // :98
  '- **Self-hosting is a hard rule:** fonts bundle with the static build; a Google Fonts request would violate zero-egress.', // :99
  '', // :100
  '**Type scale (px):** 11 (dense chips/timestamps) / 12 (tree metadata, table cells) / 13 (UI base) / 14 (reading) / 16 (pane titles) / 20 (page titles). Line-height 1.45 for reading, 1.3 for chrome. Nothing larger exists.', // :101
  '', // :102
  'Per-step line-height, so nothing is left to interpretation:', // :103
  '', // :104
  '| px  | line-height | Tailwind step | role                       |', // :105
  '| --- | ----------- | ------------- | -------------------------- |', // :106
  '| 11  | 1.3         | `text-2xs`    | dense chips, timestamps    |', // :107
  '| 12  | 1.3         | `text-xs`     | tree metadata, table cells |', // :108
  '| 13  | 1.3         | `text-sm`     | UI base                    |', // :109
  '| 14  | 1.45        | `text-base`   | reading surfaces           |', // :110
  '| 16  | 1.45        | `text-lg`     | pane titles                |', // :111
  '| 20  | 1.3         | `text-xl`     | page titles                |', // :112
  '', // :113
  '### Spacing', // :114
  '', // :115
  'Tailwind default 4px scale. Density conventions: tree rows `py-1.5` (~30px row height), table rows `py-2`, pane padding `p-4`, section gaps `gap-6`. Dense by default — this is an instrument panel, whitespace lives _around_ panes, not inside rows.', // :116
  '', // :117
  '### Radius', // :118
  '', // :119
  '`rounded-md` (6px) everywhere — buttons, inputs, cards, chips. `rounded-lg` (8px) only for floating surfaces (modals, popovers). Never `rounded-full` except status dots.', // :120
  '', // :121
  '### Shadow', // :122
  '', // :123
  'None on in-flow surfaces — borders separate panels (Vercel rule). Floating surfaces (modal, popover, context menu) get one shadow: `0 8px 24px rgb(0 0 0 / 0.5)`.', // :124
  '', // :125
  '### Motion', // :126
  '', // :127
  '- **Default:** 150ms, `cubic-bezier(0.4, 0, 0.2, 1)`.', // :128
  '- **Animate:** tree expand/collapse (height), pane slide-in, banner enter/exit, the `running` pulse (1.5s ease-in-out loop), live-row arrival (single 300ms background wash — arrival must be noticeable, not distracting).', // :129
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  '<!-- redacted -->',
  'A populated list states its size: **"N sessions"**, sharing the sort strip and right-aligned against it, in `--muted`. Singular is "1 session". The count is what the list is _showing_ — after the project narrowing, not the page total — because it exists to answer "how many am I looking at". It degrades to **"N+ sessions"** whenever that page was truncated, on the same rule the empty-state counts follow: never a number the UI cannot stand behind. Without it the count paradox is that an empty list reports its size and a full one does not.', // :169
  '', // :170
  '### Empty states', // :171
  '', // :172
  'Icon (Lucide, 24px, `--faint`) + one sentence + one action hint, e.g. "No sessions yet — start a Claude Code session and it appears here live." Never illustrations; never blank panes (Flow 3\'s "N sessions outside range" rule).', // :173
  '', // :174
  'Binding spelling of the never-captured sentence is Flow 1\'s — "No sessions yet — start a Claude Code session and it will appear here live" (`user-flows/01-first-run-install.md`) — because the example above is introduced with "e.g." and is a pattern rather than a string. The out-of-range sentence is "N sessions outside range", as written here and in Flow 3\'s diagram.', // :175
  '', // :176
  'A project narrowing that empties a non-empty range is a third case and needs its own sentence: the range is _not_ empty, so "outside range" would be false and a blank pane is forbidden. Copy: "No sessions in `{project}` in this range — N in this range across all projects.", with "Show all projects." as the action hint. Counts degrade to `N+` when the page they were counted from was truncated, never to a number the UI cannot stand behind.', // :177
  '', // :178
  '### Loading states', // :179
];

/**
 * `01-first-run-install.md`, redacted to line 14. Whole-text, not line-indexed:
 * `spec-doc.ts` pins flow copy by substring on purpose, because a flow document
 * is prose in motion and a line pin on it would break on any edit above.
 */
export const FIRST_RUN_EXCERPT: string = [
  '<!-- redacted -->',
  '4. **User** → opens the printed URL in a browser. **System** → UI loads; if no traces yet, shows the empty state: "No sessions yet — start a Claude Code session and it will appear here live", plus a `doctor` hint.',
  '<!-- redacted -->',
].join('\n');

/** `03-inspect-session.md`, redacted to lines 24,35,50. */
export const INSPECT_SESSION_EXCERPT: string = [
  '<!-- redacted -->',
  '- **Step 1: no sessions in DB** → empty state with setup instructions + `agent-lens doctor` hint (distinguish "never captured anything" from "nothing in the current time filter" — the latter says "N sessions outside this range").',
  "- **Worst case: DB corrupt/unreadable** — UI can't load anything. Show an explicit failure page (not a blank screen): the DB path, the error, and recovery options — `agent-lens doctor`, restore from backup (it's one file), worst case delete the DB and re-import from transcripts (source data still exists in `~/.claude/projects/`; the pipeline's replayability makes the DB semi-disposable).",
  '    B -->|None in range| C2["\'N sessions outside range\'<br/>widen filter"]',
  '<!-- redacted -->',
].join('\n');

/**
 * The real-spec lines each export publishes, for the founder-only drift test.
 * 1-based, matching `specLine` and the ruling above.
 */
export const PUBLISHED_LINES = {
  designSystem: [
    [62, 129],
    [169, 179],
  ] as const,
  firstRun: [14] as const,
  inspectSession: [24, 35, 50] as const,
} as const;
