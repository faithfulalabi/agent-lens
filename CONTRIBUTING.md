# Contributing

## Setup

Node.js `>=24` is required, not preferred: the storage layer uses the built-in `node:sqlite`.

```bash
npm install      # root + ui deps (ui installs via postinstall)
npm test         # the Vitest suite, node + ui projects
npm run typecheck # TypeScript strict, src + ui
npm run lint     # ESLint
npm run format   # Prettier
```

`npm test` is the gate. Never weaken a test to get it green — a red test here is usually a real
statement about the corpus, not a flaky one.

## The render loop

Most of the interesting bugs in this project are only visible against a real corpus, so the loop is
built around one:

```bash
npm run dev                        # collector + Vite UI against your real sessions
npm run dev:ui                     # the Vite UI alone, for CSS work
npm run render-gate -- --task 0.3  # drive the real UI in Chrome and assert what rendered
```

`render-gate` is the one that matters for UI changes. It boots the app, drives Chrome, and asserts
against what actually painted — not against a virtual DOM. A component that renders in a unit test
and not in a browser is a bug this project has shipped before.

With the dev server up, `/showcase` renders every design token — colours, type scale, radii, shadow,
motion — as the visual reference. Copy class names from there. Tokens are defined once in
`ui/src/styles/theme.css`.

## The one door

**`src/transcript/` is the only directory permitted to name a harness-supplied field.**

`sessionId`, `parentUuid`, `toolUseResult`, `promptId`, `isSidechain`, `tool_use_id`, `requestId`,
`message.content`, `attachment`, `origin`, `isMeta` — every read of a name Claude Code chose goes
through that directory and nowhere else. When the harness changes its shape, exactly one directory
has to change.

This is not a convention. `src/__tests__/one-door.test.ts` enforces it as a text grep over the whole
tree, tests included, and it will red on your branch if you read a harness field somewhere else.
The convention was tried alone first and lost: harness fields ended up read across 45 files.

If the gate flags you, the answer is almost always to move the read behind the door. If it genuinely
cannot move, add a `SUPPRESSIONS` entry **with a written reason** — that is the only legal way to
quiet a hit, and the entry stores the matched line so it expires when the code moves. Do not weaken
a term.

`src/__tests__/sql-one-door.test.ts` and `src/__tests__/projector-version.test.ts` are the same
shape for SQL and for projector versioning. `src/__tests__/docs.test.ts` is the same shape for these
documents.

## Two things that will surprise you on a fresh clone

**Some UI parity tests fail on a clean clone, and that is deliberate.** The design tokens and the
empty-state copy are pinned against specification documents that live in `internal_docs/`, which is
git-ignored by design and therefore absent from any clone. Three files resolve paths into it —
`ui/src/design/spec-tokens.ts` (which also pins 1-based line numbers into the token tables),
`ui/src/__tests__/spec-doc.ts` for the design system, and the same file again for the user-flow
documents. `ui/src/__tests__/tokens.test.ts` checks for the file first and fails with an explanation
rather than parsing an empty token set and passing vacuously. A loud failure was chosen over a skip
on purpose: a silently-green parity test asserts nothing.

**Golden snapshots have no update script, and that is also deliberate.** An earlier
`snapshots:update` permanently disarmed the anti-skip gate for anyone who ran it once. Regenerate a
snapshot deliberately and review the diff like code; never hand-edit one, and do not add a script
that makes regenerating them routine.

## Pull requests

Conventional Commits for the subject line (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
`perf:`), scoped to the module rather than the filename.

Before you open one: `npm test`, `npm run typecheck`, `npm run lint`. If your change touches
anything that reads the corpus, say in the PR what you measured it against — this repo has retracted
measurements before, and a number without a stated method is treated as unmeasured.
