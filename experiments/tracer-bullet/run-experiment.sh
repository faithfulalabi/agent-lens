#!/usr/bin/env bash
# One command per golden-fixture capture session (Task 1.7). Collapses the
# operator's job to: source this, read the printed prompt into a brand-new
# Claude Code session, type `done`, read the report.
#
#   source experiments/tracer-bullet/run-experiment.sh --preflight
#   source experiments/tracer-bullet/run-experiment.sh multi-turn
#   source experiments/tracer-bullet/run-experiment.sh large-output
#   source experiments/tracer-bullet/run-experiment.sh subagent
#   source experiments/tracer-bullet/run-experiment.sh compaction
#
# ##############################################################################
# THIS FILE MUST BE SOURCED, NOT EXECUTED. This is not a style preference.
#
# The adapter resolves its data dir as `dir ?? $AGENT_LENS_DIR ?? ~/.agent-lens`
# (src/capture/spool.ts:22-23), and the operator launches `claude` as a SEPARATE
# process from their own shell. An executed script's `export AGENT_LENS_DIR`
# dies with the script, so every hook would quietly write to ~/.agent-lens while
# capture.mjs read the scratch dir — four empty fixture sets, discovered late.
# Worse, the pre-flight would run inside the script's own environment and pass.
# setup.sh:8,28 already documents and implements this sourced model; this file
# follows it exactly, including the source-safe `return`.
# ##############################################################################
#
# Deliberately no `set -e`: this runs INSIDE the operator's interactive shell,
# where a single failing command must not kill the terminal. Every step checks
# its own status and returns instead.

AGENT_LENS_EXP_HOME="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
AGENT_LENS_REPO_ROOT="$(cd "$AGENT_LENS_EXP_HOME/../.." && pwd)"

# --- helpers -----------------------------------------------------------------

_al_say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
_al_err() { printf 'run-experiment: %s\n' "$*" >&2; }

# Give the operator's shell back. Sourcing means every export we make outlives
# this function, and the capture is finished by the time we return: a lingering
# AGENT_LENS_DIR would silently redirect any LATER real agent-lens work in this
# terminal into a dead scratch dir — the mirror image of the failure the sourced
# model exists to prevent. Called on EVERY exit path, including the failures.
_al_teardown() {
  if [ -n "${AGENT_LENS_SERVER_PID:-}" ]; then
    kill "$AGENT_LENS_SERVER_PID" 2>/dev/null
    wait "$AGENT_LENS_SERVER_PID" 2>/dev/null
  fi
  unset AGENT_LENS_DIR AGENT_LENS_SERVER_PID AGENT_LENS_FP_BEFORE AGENT_LENS_FP_AFTER
  return "${1:-0}"
}

_al_usage() {
  cat <<'EOF'
usage (MUST be sourced):
  source experiments/tracer-bullet/run-experiment.sh --preflight
  source experiments/tracer-bullet/run-experiment.sh <multi-turn|large-output|subagent|compaction>

Each run creates a FRESH absolute AGENT_LENS_DIR, starts a collector against it,
prints the session prompt, waits for you, then captures -> scrubs -> verifies.
EOF
}

# True when this file was sourced rather than executed. Covers bash (BASH_SOURCE
# differs from $0 only when sourced) and zsh (the founder's login shell, where
# ZSH_EVAL_CONTEXT carries a `file` frame for a sourced script).
_al_is_sourced() {
  if [ -n "${ZSH_VERSION:-}" ]; then
    case "${ZSH_EVAL_CONTEXT:-}" in
      *:file | *:file:*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  [ "${BASH_SOURCE[0]}" != "$0" ]
}

# Claude Code's on-disk project key: the absolute cwd with every non-alphanumeric
# character replaced by `-` (verified against the Task 1.5 session directory).
_al_project_dir() {
  printf '%s/.claude/projects/%s' "$HOME" "$(printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g')"
}

# Newest *.jsonl transcript in a project dir that is newer than a marker file.
_al_newest_transcript() {
  find "$1" -maxdepth 1 -name '*.jsonl' -newer "$2" -exec ls -t {} + 2>/dev/null | head -n 1
}

# sha256 + size fingerprint of a transcript; head hash detects a REWRITE
# (append-only broken), size detects growth. Q4's whole measurement.
_al_fingerprint() {
  node -e '
    const fs = require("node:fs"), c = require("node:crypto");
    const b = fs.readFileSync(process.argv[1]);
    const h = (x) => c.createHash("sha256").update(x).digest("hex").slice(0, 16);
    console.log(JSON.stringify({ size: b.length, head256: h(b.subarray(0, 256)), full: h(b) }));
  ' "$1" 2>/dev/null
}

# Count raw_events rows for a session in a collector DB. Prints 0 when the DB or
# the table does not exist yet.
_al_row_count() {
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const [dbPath, sid] = process.argv.slice(1);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const sql = sid
        ? "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?"
        : "SELECT COUNT(*) AS n FROM raw_events";
      console.log(String((sid ? db.prepare(sql).get(sid) : db.prepare(sql).get()).n));
      db.close();
    } catch { console.log("0"); }
  ' "$1" "${2:-}" 2>/dev/null
}

# --- pre-flight --------------------------------------------------------------

# Prove the hook path works END TO END before any session runs. The failure this
# exists to catch: scratch-project/.claude/settings.json invokes the bare command
# `agent-lens hook` with "async": true, so a PATH miss is SILENT — Claude Code
# never surfaces it and you capture four empty sessions.
#
# The hook is invoked under `env -i`, carrying only what Claude Code's own child
# process would carry. Running it with this shell's full environment (which has
# just run npm and may hold npm_*/NODE_OPTIONS/nvm shims) can make it succeed for
# reasons the real hook will not have — i.e. it would falsely pass.
_al_preflight() {
  local data_dir="$1" session_id="preflight-$$-$(date +%s)" waited=0 rows=0

  if ! command -v agent-lens >/dev/null 2>&1; then
    _al_err "'agent-lens' is not on PATH. Run 'npm link' in $AGENT_LENS_REPO_ROOT."
    return 1
  fi

  printf '{"session_id":"%s","hook_event_name":"SessionStart","cwd":"%s"}' \
    "$session_id" "$AGENT_LENS_EXP_HOME/scratch-project" |
    env -i HOME="$HOME" PATH="$PATH" AGENT_LENS_DIR="$data_dir" agent-lens hook

  # The adapter always exits 0 (never harm the session), so the exit code proves
  # nothing. The archived row is the only real evidence.
  while [ "$waited" -lt 20 ]; do
    rows="$(_al_row_count "$data_dir/agent-lens.db" "$session_id")"
    [ "$rows" != "0" ] && break
    sleep 0.25
    waited=$((waited + 1))
  done

  if [ "$rows" = "0" ]; then
    _al_err 'PRE-FLIGHT FAILED — no raw_events row landed. DO NOT run a session.'
    if [ -f "$data_dir/spool/$session_id.jsonl" ]; then
      _al_err '  The envelope SPOOLED: the adapter ran but could not reach the collector.'
      _al_err "  Check the collector is up and that $data_dir/config.json + token exist."
    else
      _al_err '  Nothing was even spooled: `agent-lens hook` did not run or wrote elsewhere.'
      _al_err "  Check 'command -v agent-lens' and that AGENT_LENS_DIR=$data_dir is exported."
    fi
    [ -f "$data_dir/logs/adapter.log" ] && tail -n 5 "$data_dir/logs/adapter.log" >&2
    return 1
  fi

  printf 'pre-flight OK: hook -> collector -> raw_events (session %s)\n' "$session_id"
  return 0
}

# --- the report --------------------------------------------------------------

_al_report() {
  local exp="$1" raw_dir="$2" scrubbed_dir="$3"

  _al_say "REPORT — $exp"
  [ -f "$raw_dir/manifest.json" ] && cat "$raw_dir/manifest.json"

  case "$exp" in
    large-output)
      printf '\nQ3 signature — tool_response.stdout lengths (expect 30000 for the top three bands):\n'
      node -e '
        const fs = require("node:fs");
        for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(line);
          const out = e?.raw_payload?.tool_response?.stdout;
          if (typeof out === "string") console.log(`  ${e.hook_name}: ${out.length} bytes`);
        }
      ' "$raw_dir/envelopes.jsonl" 2>/dev/null
      printf 'tool-results sidecars captured (the full, uncapped output):\n'
      ls -l "$raw_dir/tool-results" 2>/dev/null | tail -n +2 | awk '{printf "  %s  %s bytes\n", $NF, $5}'
      ;;
    subagent)
      printf '\nSub-agent sidecars (need >=2 .jsonl, each with a matching .meta.json):\n'
      ls -1 "$raw_dir/transcripts/subagents" 2>/dev/null | sed 's/^/  /'
      ;;
    compaction)
      printf '\nCompaction hooks captured:\n'
      grep -oE '"hook_name":"(Pre|Post)Compact"' "$raw_dir/envelopes.jsonl" 2>/dev/null |
        sort | uniq -c | sed 's/^/  /'
      printf '  before: %s\n  after:  %s\n' "${AGENT_LENS_FP_BEFORE:-<none>}" "${AGENT_LENS_FP_AFTER:-<none>}"
      printf '  append-only holds iff head256 is UNCHANGED and size GREW.\n'
      ;;
  esac

  cat <<EOF

NEXT — the eyeball gate is MANDATORY and not delegable (SCRUBBING.md step 2):
  1. read every file under $scrubbed_dir end to end
  2. confirm no installed skill/agent/MCP name survives in any attachment line
  3. confirm no real project path outside /home/USER/...
  4. fill the SCRUBBING.md sign-off row for "$exp", then:
       git add fixtures/scrubbed/$exp && git status   # nothing from fixtures/raw/
If anything leaks: fix the rule in scrub.config.json, add a test, re-run the
scrub. NEVER hand-edit a fixture.
EOF
}

# --- main --------------------------------------------------------------------

# Wrapper so EVERY `return` inside the body — success, usage error, failed
# pre-flight, aborted read — still tears the operator's shell back down.
_al_run_experiment() {
  _al_experiment_body "$@"
  _al_teardown "$?"
}

_al_experiment_body() {
  local exp="${1:-}" data_dir raw_dir scrubbed_dir project_dir marker transcript session_id reply

  case "$exp" in
    multi-turn | large-output | subagent | compaction | --preflight) ;;
    *)
      _al_usage
      return 2
      ;;
  esac

  _al_say 'BUILD'
  if ! (cd "$AGENT_LENS_REPO_ROOT" && npm run build >/dev/null 2>&1); then
    _al_err 'build failed — fix the base branch before capturing anything.'
    return 1
  fi

  # Absolute, and fresh per experiment. Absolute is load-bearing: a relative
  # `.capture-scratch/<exp>` resolves against the HOOK's cwd (scratch-project/),
  # landing outside every .gitignore rule. Fresh is load-bearing too: without
  # --session a stale DB would replay Task 1.5's session 46f49151 into the set.
  # Guard the rm below: if the source-time `cd`/`pwd` ever failed, HOME would be
  # empty and this would target /.capture-scratch/<exp>.
  if [ ! -f "$AGENT_LENS_EXP_HOME/capture.mjs" ]; then
    _al_err "cannot locate the experiment dir (got '$AGENT_LENS_EXP_HOME')"
    return 1
  fi
  data_dir="$AGENT_LENS_EXP_HOME/.capture-scratch/${exp#--}"
  rm -rf "$data_dir"
  mkdir -p "$data_dir"
  export AGENT_LENS_DIR="$data_dir"
  printf 'AGENT_LENS_DIR=%s (exported into THIS shell, so `claude` inherits it)\n' "$AGENT_LENS_DIR"

  _al_say 'COLLECTOR'
  (cd "$AGENT_LENS_REPO_ROOT" && AGENT_LENS_DIR="$data_dir" node bin/agent-lens.js start) &
  export AGENT_LENS_SERVER_PID=$!
  printf 'collector pid=%s (torn down automatically when this returns)\n' "$AGENT_LENS_SERVER_PID"
  local waited=0
  while [ ! -f "$data_dir/config.json" ] && [ "$waited" -lt 40 ]; do
    sleep 0.25
    waited=$((waited + 1))
  done

  _al_say 'PRE-FLIGHT'
  _al_preflight "$data_dir" || return 1
  if [ "$exp" = "--preflight" ]; then
    printf '\nPre-flight only — the hook path works. Now run a real experiment.\n'
    return 0
  fi

  project_dir="$(_al_project_dir "$AGENT_LENS_EXP_HOME/scratch-project")"
  mkdir -p "$project_dir"
  marker="$data_dir/.session-marker"
  : >"$marker"

  _al_say "SESSION — $exp"
  cat <<EOF
Open a BRAND-NEW Claude Code session (quit and relaunch 'claude' — do NOT
/clear and do NOT reuse a session; reuse is what muddied Task 1.5's fixtures):

    cd $AGENT_LENS_EXP_HOME/scratch-project && claude

Then drive the session with the prompt below.
EOF
  printf -- '----------------------------------------------------------------\n'
  cat "$AGENT_LENS_EXP_HOME/prompts/$exp.txt"
  printf -- '----------------------------------------------------------------\n'

  # compaction needs TWO checkpoints: the before-fingerprint must be taken while
  # the session is live and BEFORE /compact, or Q4 has nothing to compare.
  if [ "$exp" = "compaction" ]; then
    printf '\nRun the context-building turns, then type: fingerprint\n'
    while :; do
      printf 'compaction> '
      read -r reply || return 1
      [ "$reply" = "fingerprint" ] && break
      printf "  type 'fingerprint' once the context-building turns are done\n"
    done
    transcript="$(_al_newest_transcript "$project_dir" "$marker")"
    if [ -z "$transcript" ]; then
      _al_err "no transcript found under $project_dir — did the session start there?"
      return 1
    fi
    export AGENT_LENS_FP_BEFORE="$(_al_fingerprint "$transcript")"
    printf 'before /compact: %s\n' "$AGENT_LENS_FP_BEFORE"
    printf 'NOW run /compact, then ONE MORE TURN after it, then type: done\n'
  else
    printf '\nWhen the session is finished, type: done\n'
  fi

  while :; do
    printf '%s> ' "$exp"
    read -r reply || return 1
    [ "$reply" = "done" ] && break
    printf "  type 'done' when the session is complete\n"
  done

  _al_say 'CAPTURE'
  transcript="$(_al_newest_transcript "$project_dir" "$marker")"
  if [ -z "$transcript" ]; then
    _al_err "no transcript newer than the marker under $project_dir."
    _al_err '  The session ran somewhere else, or no turn completed.'
    return 1
  fi
  session_id="$(basename "$transcript" .jsonl)"
  printf 'transcript: %s\nsession_id: %s\n' "$transcript" "$session_id"
  [ "$exp" = "compaction" ] && export AGENT_LENS_FP_AFTER="$(_al_fingerprint "$transcript")"

  if [ "$(_al_row_count "$data_dir/agent-lens.db" "$session_id")" = "0" ]; then
    _al_err "no raw_events rows for session $session_id — hooks did not reach the collector."
    _al_err '  Pre-flight passed, so something changed mid-run. Do not commit this set.'
    return 1
  fi

  node "$AGENT_LENS_EXP_HOME/capture.mjs" \
    --exp "$exp" \
    --session "$session_id" \
    --data-dir "$data_dir" \
    --transcript "$transcript" \
    --subagent-dir "$project_dir/$session_id/subagents" \
    --tool-results-dir "$project_dir/$session_id/tool-results" \
    --claude-version "$(claude --version 2>/dev/null | head -n 1)" || return 1

  raw_dir="$AGENT_LENS_REPO_ROOT/fixtures/raw/$exp"
  scrubbed_dir="$AGENT_LENS_REPO_ROOT/fixtures/scrubbed/$exp"

  _al_say 'SCRUB'
  node "$AGENT_LENS_EXP_HOME/scrub.mjs" \
    --in "$raw_dir" --out "$scrubbed_dir" \
    --config "$AGENT_LENS_EXP_HOME/scrub.config.json" \
    --home "$HOME" --user "$USER" || return 1

  _al_say 'VERIFY'
  if ! node "$AGENT_LENS_EXP_HOME/verify.mjs" \
    --dir "$scrubbed_dir" --config "$AGENT_LENS_EXP_HOME/scrub.config.json" \
    --home "$HOME" --user "$USER"; then
    _al_err 'verify found residue — triage every hit above before going further.'
    _al_report "$exp" "$raw_dir" "$scrubbed_dir"
    return 1
  fi

  _al_report "$exp" "$raw_dir" "$scrubbed_dir"
  return 0
}

if _al_is_sourced; then
  _al_run_experiment "$@"
else
  printf 'run-experiment.sh must be SOURCED, not executed.\n' >&2
  printf '  AGENT_LENS_DIR must reach the `claude` process you launch afterwards;\n' >&2
  printf '  an executed script cannot export into your shell (see the header).\n' >&2
  printf '  Use: source experiments/tracer-bullet/run-experiment.sh <exp>\n' >&2
  exit 1
fi
