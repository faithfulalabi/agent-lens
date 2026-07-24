# Fixture Scrubbing — Auditable Procedure

Raw captures under `fixtures/raw/` are classified **sensitive** (they may echo
secrets, tokens, private paths, or PII the agent touched). They are **git-ignored
and must never be committed**. Only scrubbed, manually-reviewed fixtures under
`fixtures/scrubbed/` may enter the repo. This posture is "assume worst": treat
every raw payload as if it contains a live secret until proven otherwise.

## Pipeline

```
fixtures/raw/<exp>/          # git-ignored, produced by capture.mjs
  -> scrub.mjs (scrub.config.json)  # deterministic regex redaction + path/user anonymization
  -> fixtures/scrubbed/<exp>/       # committed AFTER manual review
```

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

The scrubber **preserves JSON shape and Q3 size markers**, so scrubbed envelope
fixtures still POST cleanly through `/api/ingest` (Phases 2–4 replay them).

## Step 2 — MANDATORY manual eyeball gate

Regex is necessary but **not sufficient**. Before committing, a human MUST read
every scrubbed file end to end and confirm:

- [ ] No `sk-`, `sk-ant-`, `AKIA`, `ghp_/gho_`, `eyJ…`, or bearer token remains.
- [ ] No real home dir, username, hostname, or private IP remains.
- [ ] No email / customer name / real project path remains.
- [ ] No secret in an unexpected place (URL query string, tool_input arg, env dump).
- [ ] JSON still parses and preserves the original event shape.

Verification greps (all must return **zero hits**):

```bash
grep -rEi 'sk-(ant-)?[A-Za-z0-9]|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]+\.' fixtures/scrubbed/
grep -rF "$HOME" fixtures/scrubbed/
grep -rF "$USER" fixtures/scrubbed/
```

## Step 3 — Sign-off

Record sign-off here per fixture set before its commit:

| Fixture set  | Scrubbed | Grep clean | Eyeballed by           | Date |
| ------------ | :------: | :--------: | ---------------------- | ---- |
| multi-turn   |    ☐     |     ☐      | _pending live session_ | —    |
| subagent     |    ☐     |     ☐      | _pending live session_ | —    |
| large-output |    ☐     |     ☐      | _pending live session_ | —    |
| compaction   |    ☐     |     ☐      | _pending live session_ | —    |

> **Open judgement call for Task 1.6:** if regex + anonymization + manual review
> is deemed insufficient for the sensitivity class, the fallback is synthetically
> regenerated fixtures (real structure, fabricated content). That is a founder
> decision at the 1.6 gate.
