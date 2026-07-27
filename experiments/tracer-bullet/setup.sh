#!/usr/bin/env bash
# Bootstrap the tracer-bullet experiment harness. Creates an isolated data dir,
# starts the agent-lens collector against it, and points a scratch Claude Code
# project at project-scoped hooks. NOTHING here touches the founder's global
# ~/.claude config — hooks live only under scratch-project/.claude/settings.json.
#
# Usage:
#   source experiments/tracer-bullet/setup.sh   # exports AGENT_LENS_DIR, starts server
#   # ... run experiments (see README.md) ...
#   kill "$AGENT_LENS_SERVER_PID"                # tear down when done
#
# Safe to re-run: the data dir is created with mkdir -p; a stale server should
# be killed first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# 1. Isolated, ephemeral data dir (git-ignored). Never the default ~/.agent-lens.
export AGENT_LENS_DIR="${AGENT_LENS_DIR:-$HERE/.capture-scratch}"
mkdir -p "$AGENT_LENS_DIR"
echo "AGENT_LENS_DIR=$AGENT_LENS_DIR"

# 2. Build once so `agent-lens` (dist) is current before hooks fire.
( cd "$REPO_ROOT" && npm run build >/dev/null 2>&1 ) || {
  echo "build failed — fix the base branch before running experiments" >&2
  return 1 2>/dev/null || exit 1
}

# 3. Start the collector in the background against the scratch data dir.
( cd "$REPO_ROOT" && AGENT_LENS_DIR="$AGENT_LENS_DIR" node bin/agent-lens.js start ) &
export AGENT_LENS_SERVER_PID=$!
echo "collector pid=$AGENT_LENS_SERVER_PID (kill it to tear down)"

# 4. Remind the operator how to point Claude Code at the scratch hooks.
cat <<EOF

Scratch project ready.

For GOLDEN-FIXTURE capture use run-experiment.sh instead of these steps — it
does the pre-flight, capture, scrub and verify for you (and this collector is
already running, so kill \$AGENT_LENS_SERVER_PID first):
  source $HERE/run-experiment.sh <multi-turn|large-output|subagent|compaction>

Manual path (ad-hoc probing):
  1. cd $HERE/scratch-project        # project-scoped .claude/settings.json
  2. Ensure 'agent-lens' resolves on PATH (npm link, or use an absolute command).
  3. Run the scripted prompts in ../prompts/ inside a Claude Code session here.
  4. Capture:  node $HERE/capture.mjs --exp <name> --session <session-id> \\
                 --data-dir "\$AGENT_LENS_DIR" --transcript <parent.jsonl>
  5. Scrub:    node $HERE/scrub.mjs --in fixtures/raw/<name> --out fixtures/scrubbed/<name> \\
                 --config $HERE/scrub.config.json --home "\$HOME" --user "\$USER"
  6. Verify:   node $HERE/verify.mjs --dir fixtures/scrubbed/<name> \\
                 --config $HERE/scrub.config.json --home "\$HOME" --user "\$USER"
  7. EYEBALL the scrubbed output (SCRUBBING.md) before committing.

Pure-code probes need no session:
  node $HERE/fts5-probe.mjs        # Q7
EOF
