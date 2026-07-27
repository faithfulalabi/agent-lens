# Tracer-Bullet Validation Harness (Task 1.5)

Scripted scratch-project capture harness for empirically confirming the seven
behaviors the agent-lens architecture depends on. It consumes the working
capture path from Tasks 1.1–1.4 (adapter + server + shared contract) and
produces (a) an evidence-backed findings doc and (b) scrubbed golden fixtures
for Phases 2–4.

> **This directory is scaffolding.** The _deliverable_ is decision-grade
> evidence in `internal_docs/agent-lens/research/tracer-bullet-findings.md`. Most
> questions require a **live, human-driven Claude Code session** (sub-agent
> spawns, interactive `/compact`, multi-turn, large-output). Only **Q7 (FTS5)**
> is fully answerable by code alone and is done here.

## The seven questions

| #   | Question                                                              | How                                     | Session needed?            |
| --- | --------------------------------------------------------------------- | --------------------------------------- | -------------------------- |
| Q1  | Sub-agent Pre/PostToolUse fire + carry `agent_id`                     | `prompts/subagent.txt`                  | **Live** (Task tool spawn) |
| Q2  | Sub-agent transcript separation via `agent_transcript_path`           | `prompts/subagent.txt`                  | **Live**                   |
| Q3  | Hook `tool_output` truncation threshold                               | `prompts/large-output.txt` + `emit.mjs` | **Live** (tool runs)       |
| Q4  | Transcript append-only through `/compact`                             | `prompts/compaction.txt`                | **Live, interactive only** |
| Q5  | Transcript field reality (`usage`/`model`/`isSidechain`/`parentUuid`) | `prompts/multi-turn.txt`                | **Live** (inspect JSONL)   |
| Q6  | `async:true` ordering                                                 | `ordering-probe.mjs`                    | **Live** (needs a capture) |
| Q7  | FTS5 present in `node:sqlite`                                         | `fts5-probe.mjs`                        | **No — code only ✅**      |

## Files

- `run-experiment.sh` — **the entry point** (Task 1.7). One `source` per capture session: build, pre-flight, collector, prompt, capture, scrub, verify, report.
- `setup.sh` — lower-level bootstrap: isolated `AGENT_LENS_DIR`, build, start collector, point at scratch hooks.
- `scratch-project/.claude/settings.json` — **project-scoped** hooks (5 base + SubagentStart/Stop + Pre/PostCompact). Never the founder's global config.
- `emit.mjs` — emits EXACTLY N bytes with 512-byte offset markers (Q3 bait). `node emit.mjs 1MB`.
- `capture.mjs` — snapshot `raw_events` + spool + transcripts + `subagents/` + `tool-results/` + a `manifest.json` into `<repo>/fixtures/raw/<exp>/`.
- `scrub.mjs` + `scrub.config.json` — attachment stripping (`.jsonl`), secret redaction, path/user anonymization.
- `verify.mjs` — the residue gate. Scans a scrubbed dir with the config's `detectRules`, reports `file:line:rule`, exits 1 on any hit.
- `SCRUBBING.md` — the mandatory scrub procedure + manual eyeball gate + sign-off table.
- `fts5-probe.mjs` — Q7, fully automated. Records node + sqlite versions and PASS/FAIL.
- `ordering-probe.mjs` — Q6 inversion table (pure `detectInversions` core + live CLI).
- `prompts/{subagent,large-output,multi-turn,compaction}.txt` — the scripted session drivers. **The filename is the experiment key** — `run-experiment.sh <exp>` reads `prompts/<exp>.txt`.

## Quick start

```bash
# Q7 — no session required, run it now:
node fts5-probe.mjs

# Golden-fixture capture (needs a real Claude Code install + `npm link`):
source experiments/tracer-bullet/run-experiment.sh --preflight
source experiments/tracer-bullet/run-experiment.sh multi-turn
# ...then large-output, subagent, compaction — a BRAND-NEW session each time.
```

> **`run-experiment.sh` must be `source`d, never executed.** It exports
> `AGENT_LENS_DIR` into your shell so the `claude` process you launch next
> inherits it (`src/capture/spool.ts:22-23`). An executed script's export dies
> with the script: hooks would write to `~/.agent-lens` while capture read the
> scratch dir, and the pre-flight — running inside the script's own env — would
> falsely pass. The script refuses to run if it was executed.

The script prints the prompt, waits for you to type `done` (`compaction` also
asks for a `fingerprint` checkpoint before `/compact`), then captures, scrubs,
verifies, and prints a report. The manual eyeball gate (SCRUBBING.md) is still
mandatory before `git add`.

## Safety invariants

- **Never** write hooks to the repo-root `.claude` or the founder's global
  `~/.claude` — only `scratch-project/.claude/settings.json`.
- `**/fixtures/raw/` and `**/.capture-scratch/` are **git-ignored**; un-scrubbed
  data can never be committed. The `**/` is load-bearing — a gitignore pattern
  with an interior slash is root-anchored, and the un-prefixed version did not
  cover `experiments/tracer-bullet/fixtures/raw/`, which is where Task 1.5
  actually wrote (`gitignore.test.mjs` asserts this).
- `capture.mjs` anchors its output to the repo root, not `process.cwd()`, so raw
  lands in an ignored path no matter where the operator stands.
- The scrub pass + `verify.mjs` + manual gate (SCRUBBING.md) are all mandatory
  before any fixture enters `fixtures/scrubbed/`.
