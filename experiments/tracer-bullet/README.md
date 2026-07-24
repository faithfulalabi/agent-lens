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
| Q1  | Sub-agent Pre/PostToolUse fire + carry `agent_id`                     | `prompts/subagents.txt`                 | **Live** (Task tool spawn) |
| Q2  | Sub-agent transcript separation via `agent_transcript_path`           | `prompts/subagents.txt`                 | **Live**                   |
| Q3  | Hook `tool_output` truncation threshold                               | `prompts/large-output.txt` + `emit.mjs` | **Live** (tool runs)       |
| Q4  | Transcript append-only through `/compact`                             | `prompts/compaction.txt`                | **Live, interactive only** |
| Q5  | Transcript field reality (`usage`/`model`/`isSidechain`/`parentUuid`) | `prompts/multi-turn.txt`                | **Live** (inspect JSONL)   |
| Q6  | `async:true` ordering                                                 | `ordering-probe.mjs`                    | **Live** (needs a capture) |
| Q7  | FTS5 present in `node:sqlite`                                         | `fts5-probe.mjs`                        | **No — code only ✅**      |

## Files

- `setup.sh` — bootstrap: isolated `AGENT_LENS_DIR`, build, start collector, point at scratch hooks.
- `scratch-project/.claude/settings.json` — **project-scoped** hooks (5 base + SubagentStart/Stop + Pre/PostCompact). Never the founder's global config.
- `emit.mjs` — emits EXACTLY N bytes with 512-byte offset markers (Q3 bait). `node emit.mjs 1MB`.
- `capture.mjs` — snapshot `raw_events` + spool + touched transcripts into `fixtures/raw/<exp>/`.
- `scrub.mjs` + `scrub.config.json` — deterministic secret redaction + path/user anonymization.
- `SCRUBBING.md` — the mandatory scrub procedure + manual eyeball gate + sign-off table.
- `fts5-probe.mjs` — Q7, fully automated. Records node + sqlite versions and PASS/FAIL.
- `ordering-probe.mjs` — Q6 inversion table (pure `detectInversions` core + live CLI).
- `prompts/{subagents,large-output,multi-turn,compaction}.txt` — the scripted session drivers.

## Quick start

```bash
# Q7 — no session required, run it now:
node fts5-probe.mjs

# Full harness (needs a real Claude Code install):
source setup.sh            # exports AGENT_LENS_DIR, starts collector
cd scratch-project         # project-scoped hooks live here
# run the prompts/*.txt drivers in a Claude Code session, then:
node ../capture.mjs --exp <name> --data-dir "$AGENT_LENS_DIR" --transcripts "<paths>"
node ../scrub.mjs --in ../fixtures/raw/<name> --out ../fixtures/scrubbed/<name> \
  --config ../scrub.config.json --home "$HOME" --user "$USER"
# EYEBALL the scrubbed output (SCRUBBING.md) before committing.
```

## Safety invariants

- **Never** write hooks to the repo-root `.claude` or the founder's global
  `~/.claude` — only `scratch-project/.claude/settings.json`.
- `fixtures/raw/` and `.capture-scratch/` are **git-ignored**; un-scrubbed data
  can never be committed.
- The scrub pass + manual gate (SCRUBBING.md) is mandatory before any fixture
  enters `fixtures/scrubbed/`.
