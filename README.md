# agent-lens

An open-source, local-first agentic tracing platform: install a plugin in your agent harness (Claude Code first), spin up a local UI, and inspect everything your agent did in a session — tool calls, sub-agents, prompts, inputs/outputs — so you can improve your workflow and guide the agent better.

## Status

Pre-alpha. Product spec and technical planning live in [`internal_docs/agent-lens/`](internal_docs/agent-lens/) — start with [`PROJECT.md`](internal_docs/agent-lens/PROJECT.md).

## The archive — read this before you delete anything

Claude Code deletes its own transcripts. Measured on a real corpus: the files
thin out from about 25 days old and **nothing older than 41 days survives**, and
53 of 97 referenced `tool-results/*.txt` spill files were already gone. Once a
file expires, no one can ever see it again.

`agent-lens archive` mirrors `~/.claude/projects/**` verbatim into
`~/.agent-lens/archive/**` — the same bytes at a different path, so `cp` backs it
up and a byte comparison verifies it. It is append-only and never writes to
`~/.claude/projects`.

> **`rm cache.db` loses nothing** — the database is a derived cache and can be
> rebuilt from the archive.
> **`rm -rf ~/.agent-lens/archive` loses data permanently.** It is the system of
> record. There is no other copy.

Put it on a cron. It is safe to run every minute: an advisory lock means a second
pass copies nothing and exits 0, an unchanged corpus copies zero bytes, and a
pass with nothing to report writes no log line.

```bash
* * * * * /path/to/agent-lens archive
```

| Flag                     | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `--json`                 | emit the full pass report (the stable contract for `doctor`) |
| `--dataDir <dir>`        | override `~/.agent-lens`                                     |
| `--transcriptRoot <dir>` | override `~/.claude/projects`                                |
| `--verify`               | full-file integrity audit — **not for the per-minute cron**  |

Each pass compares a 4 KB head and a 4 KB seam per file, which is roughly 1% of
the corpus by bytes: enough to catch a rewritten file at the point an append
would splice onto it, and deliberately not a full integrity check. `--verify`
re-reads every archived file and its source in full and is the real audit — it
costs a read of the entire corpus, so run it periodically by hand or on a weekly
cron, never every minute.

When a source has been rewritten (it shrank, or its head or seam changed), the
archived bytes are **kept** and the file is marked `diverged` rather than
overwritten, and the event is recorded in `~/.agent-lens/logs/archive.jsonl`.

## Development

Requires Node.js `>=24` (the SQLite layer uses the built-in `node:sqlite`).

```bash
npm install      # installs root + ui deps
npm test         # run the Vitest suite
npm run dev       # boot the collector + Vite UI against your real sessions
npm run dev:ui    # boot the Vite UI alone (CSS work, no collector)
npm run render-gate -- --task 0.3  # drive the real UI in Chrome, assert what rendered
npm run typecheck # TypeScript strict check (src + ui)
npm run lint      # ESLint
node ./bin        # print the CLI help

npm run snapshots:update  # regenerate the golden projection snapshots
```

With the dev server running, [`/showcase`](http://localhost:5173/showcase) renders
every design token — colors, type scale, radii, shadow, motion — as the visual
reference for UI work. Copy class names from there; the tokens are defined once in
`ui/src/styles/theme.css` and tested against `internal_docs/agent-lens/spec/design-system.md`.

`snapshots:update` is the **only** supported way to change the committed
projection snapshots in `src/capture/__tests__/__snapshots__/golden/`. Run it
when a schema or normalizer change is intentional, then review the resulting
line diff like any other code change — never hand-edit a snapshot.
