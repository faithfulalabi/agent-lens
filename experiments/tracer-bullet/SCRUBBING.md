# Fixture Scrubbing — Auditable Procedure

Raw captures under `fixtures/raw/` are classified **sensitive** (they may echo
secrets, tokens, private paths, or PII the agent touched). They are **git-ignored
and must never be committed**. Only scrubbed, manually-reviewed fixtures under
`fixtures/scrubbed/` may enter the repo. This posture is "assume worst": treat
every raw payload as if it contains a live secret until proven otherwise.

## Pipeline

```
fixtures/raw/<exp>/          # git-ignored, produced by capture.mjs
  -> scrub.mjs (scrub.config.json)  # attachment strip + regex redaction + path/user anonymization
  -> verify.mjs (detectRules)       # independent residue gate, exits 1 on any hit
  -> fixtures/scrubbed/<exp>/       # committed AFTER manual review
```

`source run-experiment.sh <exp>` runs all three for you. The steps below are
what it does, and what to do when a gate fires.

## Step 1 — Automated scrub (deterministic)

```bash
node scrub.mjs \
  --in fixtures/raw/<exp> \
  --out fixtures/scrubbed/<exp> \
  --config scrub.config.json \
  --home "$HOME" --user "$USER"
```

`scrub.config.json` is the auditable source of truth for what gets redacted.
Rules (each → a stable placeholder, so fixtures stay diff-stable):

| Rule                     | Shape redacted                               |
| ------------------------ | -------------------------------------------- |
| `anthropic-api-key`      | `sk-ant-…`                                   |
| `openai-api-key`         | `sk-…`                                       |
| `aws-access-key-id`      | `AKIA…`                                      |
| `github-token`           | `ghp_/gho_/ghu_/ghs_/ghr_…`                  |
| `jwt`                    | `eyJ….….…`                                   |
| `bearer-header`          | `Authorization: Bearer …`                    |
| `agentlens-token-header` | `x-agentlens-token: …`                       |
| `keyish-assignment`      | `*_KEY / *_TOKEN / *_SECRET / *PASSWORD = …` |
| `email`                  | any email → `user@example.com`               |
| `private-ip-*`           | RFC-1918 ranges → range base                 |

Plus: `$HOME` → `/home/USER`, `$USER` → `USER`.

**Structural strip (`.jsonl` files only, applied BEFORE the regex pass).** Claude
Code transcripts carry `type:"attachment"` lines whose body is the operator's
installed skill/agent/MCP inventory — measured at **63–66% of transcript bytes**
on the Task 1.5 captures, and a pure environment-config leak with no fixture
value. Regex cannot reach it, so `scrubJsonl` handles it structurally:

| Strip               | What happens                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type:"attachment"` | `attachment` body → `{type:<kind>,stripped:true}`; every other key byte-identical                                                                                              |
| kinds covered       | `skill_listing`, `agent_listing_delta`, `deferred_tools_delta`, `mcp_instructions_delta`, `task_reminder` — **and any future kind** (`stripAllAttachments: true` fails closed) |

The line is kept, not dropped: line count, ordering, and the `uuid`/`parentUuid`
chain survive, so the scrubbed transcript still exercises Phase 3's append-only
tailer.

The scrubber **preserves JSON shape and Q3 size markers**, so scrubbed envelope
fixtures still POST cleanly through `/api/ingest` (Phases 2–4 replay them). Join
keys (`session_id`, `uuid`/`parentUuid`, `tool_use_id`, `prompt_id`, `agent_id`,
ISO timestamps) are **never** rewritten — Tasks 2.6 and 4.3 correlate on them.

## Step 2 — Automated verification gate

```bash
node verify.mjs --dir fixtures/scrubbed/<exp> --home "$HOME" --user "$USER"
```

Exits **0** when clean, **1** with a `file:line:rule` report per hit.

This replaces the hand-copied shell greps this document used to carry. Those
greps were a _second, looser copy_ of `scrub.config.json`'s patterns, and the
drift was the defect: the copy had no length quantifier, so `sk-b` inside
`task-break` matched and the gate was unpassable for any fixture mentioning one
of this repo's own task names (`task-break`, `task-review`, `task-shipper`,
`disk-usage`). The scrubber itself was never wrong.

`verify.mjs` reads its patterns from `scrub.config.json` — but from a **separate
`detectRules` set**, not from `rules`. That matters in both directions:

- reusing `rules` would make the gate return zero **by construction**: a
  tautology that cannot catch a scrub rule tightened past a real secret;
- hand-copying `rules` into a shell script is what broke last time.

So `detectRules` lives in the same file (one source of truth) with deliberately
**lower quantifiers** than the redactor. Expect it to occasionally flag
something `scrubText` leaves alone — that is the point, and each hit is triaged
here at the eyeball gate. Both directions are unit-tested (`verify.test.mjs`),
and the same scan runs over all of `fixtures/scrubbed/**` on every `npm test`.

## Step 3 — MANDATORY manual eyeball gate

Regex is necessary but **not sufficient**. Before committing, a human MUST read
every scrubbed file end to end and confirm:

- [ ] No `sk-`, `sk-ant-`, `AKIA`, `ghp_/gho_`, `eyJ…`, or bearer token remains.
- [ ] No real home dir, username, hostname, or private IP remains.
- [ ] No email / customer name / real project path remains (nothing outside `/home/USER/…`).
- [ ] No secret in an unexpected place (URL query string, tool_input arg, env dump).
- [ ] JSON still parses and preserves the original event shape.
- [ ] **No installed skill/agent/MCP name survives in any `attachment` line** —
      every one should read `{"type":<kind>,"stripped":true}`.
- [ ] `tool-results/*.txt` (large-output set) reviewed too — it is raw command
      output and may carry paths the transcript does not.

If anything leaks: fix the rule in `scrub.config.json`, add a test, re-run the
scrub. **Never hand-edit a fixture** — it breaks reproducibility, and the next
re-capture silently reintroduces the leak.

## Step 4 — Sign-off

Record sign-off here per fixture set before its commit:

| Fixture set  | Scrubbed | `verify.mjs` clean | Attachments stripped | Eyeballed by           | Date |
| ------------ | :------: | :----------------: | :------------------: | ---------------------- | ---- |
| multi-turn   |    ☐     |         ☐          |          ☐           | _pending live session_ | —    |
| subagent     |    ☐     |         ☐          |          ☐           | _pending live session_ | —    |
| large-output |    ☐     |         ☐          |          ☐           | _pending live session_ | —    |
| compaction   |    ☐     |         ☐          |          ☐           | _pending live session_ | —    |

> **Task 1.6 ruling (2026-07-25, binding).** Synthetic regeneration is **ruled
> out**. The fixtures are real captures: fix the scrub tooling and re-capture
> cleanly, one dedicated Claude Code session per experiment — the single reused
> session `46f49151` muddied Task 1.5's per-experiment sets
> (`research/tracer-bullet-findings.md:349-354`).
