#!/usr/bin/env node
// The published entry point. It runs the BUILT CLI in-process: no transpiler, no
// source tree, no child process.
//
// In-process is load-bearing, not a tidy-up. The previous shim launched a child
// with a transpiler forking underneath it: a three-process chain that swallowed
// signals, recorded at src/cli/__tests__/start-signals.test.ts:7-12. Calling
// `main` here puts SIGINT/SIGTERM/SIGHUP straight onto the handlers
// `commands/start` registers, so `agent-lens start` survives a real kill.
//
// The tokens this file must never contain are therefore spelled nowhere in it,
// prose included — the render gate's own precedent for a substring pin, since a
// comment satisfies `toContain` just as well as code does. The list lives in
// src/packaging.test.ts, under "resolves the built CLI in-process".
//
// The UI still resolves: `resolveUiDir` in src/server/static-ui walks up to the
// nearest package.json instead of using a fixed relative path, precisely because
// the built server sits one directory deeper than the source one.

const MIN_NODE_MAJOR = 24;
const major = Number.parseInt(process.versions.node, 10);

if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
  // Ahead of the import, never after it. The CLI graph reaches node:sqlite
  // (src/db/open) and zstd (src/archive/seal), so on an older Node the first
  // symptom would be ERR_UNKNOWN_BUILTIN_MODULE from deep inside the DB layer.
  // npm will not catch it either: `engine-strict` defaults to false, which makes
  // the `engines` field a warning that installs anyway.
  process.stderr.write(
    `agent-lens needs Node 24 or newer; this is Node ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  // Dynamic, so the guard above runs first — a static import would hoist past it.
  const { main } = await import('../dist/src/cli/index.js');
  // Setting the code and returning, rather than terminating the process here:
  // the abrupt form truncates piped stdout mid-write. Exit codes 0/1/3 from
  // `commands/archive` flow through unchanged either way.
  process.exitCode = await main(process.argv.slice(2));
}
