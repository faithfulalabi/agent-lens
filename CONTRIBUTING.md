# Contributing

## Setup

Node.js `>=24` is required, not preferred: the storage layer uses the built-in `node:sqlite`.

```bash
npm install      # root + ui deps (ui installs via `prepare`)
npm test         # the Vitest suite, node + ui projects
npm run typecheck # TypeScript strict, src + ui
npm run lint     # ESLint
npm run format   # Prettier
```

CI's `test` job needs a repository secret, so a pull request from a fork cannot go green on its
own — a maintainer re-pushes the branch into this repo to run CI.

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

**Pull requests are squash-merged, and the PR title becomes the commit.** `main` accepts squash
merges only, with the PR title as the commit subject and the PR description as its body. The
`pr-title` check fails unless the title is a Conventional Commit subject (for example
`fix(search): keep the cursor on refresh`), because that title is exactly what the release tooling
reads. Keep the PR description free of lines that look like Conventional headers (`fix: …`,
`feat(x): …`) or a `BREAKING CHANGE:` footer unless you mean them: each one can add a changelog
entry or force a version bump.

## Releasing

Releases are cut by CI from `.github/workflows/ci.yml`. Nobody runs `npm publish` by hand.

**How a release happens.** After every push to `main` that passes `lint`, `test` and `smoke`, the
`release` job asks `scripts/release-scope.ts` whether anything since the last `v*` tag can change the
published tarball (`bin/`, `src/` outside tests and dev tooling, `ui/src/`, the build configs,
`package.json`, `README.md`, `LICENSE`). Tests, docs, CI, scripts and fixtures never can, so a merge
touching only those does nothing. If shipped code changed, release-please opens or refreshes a PR
titled `chore(release): X.Y.Z` that bumps `package.json`, `package-lock.json` and `CHANGELOG.md`.
**Merging that PR is the release.** The push it creates tags `vX.Y.Z`, creates the GitHub release
with the changelog entry as its notes, and publishes to npm the exact tarball the `smoke` job
installed and drove in Chrome, with provenance, over npm trusted publishing (no npm token exists).
`node scripts/release-scope.ts --base v0.1.0` prints the same decision locally.

**Version bumps come from commit types.** While the version is `0.x`:

| Commit                    | Bump  | Example           |
| ------------------------- | ----- | ----------------- |
| `fix:` / `perf:`          | patch | `0.1.0` → `0.1.1` |
| `feat:`                   | minor | `0.1.0` → `0.2.0` |
| `!` or `BREAKING CHANGE:` | minor | `0.1.0` → `0.2.0` |

`refactor:`, `docs:`, `test:`, `chore:` and `ci:` never cut a release on their own; they ride along
with the next `fix` or `feat`. To graduate to `1.0.0`, merge a PR whose description ends with the
footer line `Release-As: 1.0.0`; after that, standard semver applies with no config change.

**Fully automatic mode.** Setting the repository variable `RELEASE_AUTOMERGE=true` makes CI enable
auto-merge on each release PR, so it merges itself once its checks pass. It refuses to run unless
`main` has an active required-checks ruleset, and it needs "Allow auto-merge" turned on in the
repository settings.

**If a publish fails.** The tag and GitHub release stay in place on purpose: they describe a real
commit. Open that commit's CI run and use "Re-run failed jobs"; `publish-check` sees the tag at that
commit and the version missing from npm, and publishes the same tarball (kept for 30 days). A re-run
of an already-published version is a no-op, and a `release` job that shows cancelled because several
pushes landed at once is fixed the same way. Until it is fixed, `publish-check` on every later `main`
push fails with `released but unpublished`, so a stuck release cannot go unnoticed. Past 30 days,
check out the tag, run `SMOKE_KEEP_TGZ=/tmp/tgz npm run smoke:pack`, and publish that tarball from
CI.

**The workflow filename is load-bearing.** npm's trusted-publisher entry names `ci.yml` and the
`npm-publish` environment. Renaming the file, or moving the `publish` job into another workflow,
breaks publishing until the entry on npmjs.com is updated.

### One-time setup (maintainer)

1. Create a GitHub App (for example `agent-lens-release`) with the webhook off and repository
   permissions Contents, Pull requests and Issues set to read and write, plus Metadata read. Install
   it on this repository only and generate a private key. Store the key as the Actions secret
   `RELEASE_APP_PRIVATE_KEY` and the App's Client ID as the Actions variable `RELEASE_APP_CLIENT_ID`.
   Until that variable exists the `release` job skips.
2. Create the environment `npm-publish`, with deployment branches limited to `main`.
3. On npmjs.com, add a trusted publisher to `@faithfulalabi/agent-lens`: GitHub Actions, user
   `faithfulalabi`, repository `agent-lens`, workflow `ci.yml`, environment `npm-publish`. Then set
   publishing access to require two-factor authentication and disallow tokens.
4. Make the repository squash-only, with the PR title and description as the commit message.
5. Apply the `main` ruleset pinned in `.github/ruleset-main.json`, which requires `lint`, `test`,
   `smoke` and `pr-title`, allows squash merges only, and has no bypass actors.
6. Only for fully automatic mode: allow auto-merge in the repository settings and set
   `RELEASE_AUTOMERGE=true`.
