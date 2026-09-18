# Security

agent-lens holds the most sensitive material on your machine. A transcript contains your source
code, your prompts, the contents of the files an agent read, and any secret that passed through a
tool call. Treat `~/.agent-lens/` with the same care as the repositories it traces.

This document states the local trust boundary explicitly. Everything below is a design property,
not an accident.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** form on the repository's Security tab
(<https://github.com/faithfulalabi/agent-lens/security/advisories/new>). Please do not open a public
issue for anything that gives another party access to trace data.

Include the version or commit, the platform, and the smallest reproduction you have. You will get an
acknowledgement within a week. There is no bug bounty; this is a single-maintainer project.

## The trust boundary

### 1. The traced agent itself can read the trace API

**This is the property most people do not expect, so it is stated first.** agent-lens runs on the
same machine as the agent it traces, and that agent can run shell commands as you. It can therefore
read `~/.agent-lens/token`, call the local API, and read every trace — including traces of other
sessions and other projects.

There is no boundary between agent-lens and the agent it observes, and this design does not pretend
to build one. A local trace store cannot defend against a local process running with your
privileges. If you run an agent you do not trust, it already has your source tree; agent-lens does
not change that calculation, but it does concentrate your history in one readable place.

Scope your trust accordingly: the token defends against _other users_ on a shared machine and
against the browser, not against the agent.

### 2. The server binds loopback by default

`agent-lens start` binds `127.0.0.1`. Nothing is reachable off the machine unless you explicitly
pass `--host`, and a non-loopback bind prints a loud multi-line warning naming the exposure before
it serves anything (`src/server/start.ts`).

A non-loopback bind is a real decision, not a convenience flag: on that path the token becomes the
only thing standing between your traces and everyone on the network.

### 3. Every request is checked against a Host-header allowlist

Binding to loopback is not by itself enough. Any web page you visit can resolve a hostname it
controls to `127.0.0.1` — DNS rebinding — and then issue requests to the local server from your
browser, with your browser's network position.

So the allowlist runs app-wide, ahead of authentication, and rejects any request whose `Host`
hostname is not a loopback name (`localhost`, `127.0.0.1`, `::1`). A non-loopback `--host` bind
widens the list to that machine's own interface addresses and no further — never to a wildcard
(`src/server/middleware/host-guard.ts`).

### 4. The token model

- A 32-byte random token is generated on first start and stored at `~/.agent-lens/token` with mode
  `0600`. The write is atomic — a temp sibling created `0600` and renamed into place — so a reader
  never sees a partial token (`src/shared/token.ts`).
- Every `/api/*` request must carry it in the `x-agentlens-token` header. The comparison is
  constant-time; a missing or mismatched token is a `401` with no body detail
  (`src/server/middleware/token-auth.ts`).
- The token travels in a **header, never a query string**, so it does not land in a URL, a referrer
  or a server log.
- The static page is deliberately **not** token-guarded. It is served with the token injected
  same-origin, which is how the UI bootstraps without you ever pasting a credential. That route is
  registered ahead of the auth middleware on purpose (`src/server/app.ts`), and the Host allowlist
  above is what keeps a foreign page from being the one that receives it.

### 5. Archive writes are contained and refuse symlinked destinations

Everything the archive pass writes — mirrored bytes, the seal, the pass log, the lock — lands under
the data dir (default `~/.agent-lens`), and each write is checked against its root. Directory chains
are asserted to resolve inside the archive root or the data dir both before and after they are
created, and every final path component is either opened with `O_NOFOLLOW` or created with
`O_CREAT|O_EXCL`, so a symlink planted at a write destination is refused by the kernel instead of
followed (`src/archive/paths.ts`).

The archive root itself may be a symlink — relocating a keep-forever store onto another volume is
supported. What is refused is any resolution that escapes the root, and in particular anything that
lands inside the transcript corpus: the pass refuses to write into `~/.claude/projects` even when
`--dataDir` points at it (`src/archive/mirror.ts`).

Two limits, stated rather than rounded up: a symlink planted in the window between a containment
check and the create it guards is caught only at the final write, and a dangling symlinked ancestor
is refused by the kernel's own error rather than by the guard. Node exposes no `openat`/`mkdirat`
directory-fd syscalls, so that window is a permanent property of the runtime; the guarantee is
strongest at the final path component.

### 6. A spill path declared by a transcript is only read from inside known roots

A transcript line can declare the absolute path of a spilled tool output — the structured
`persistedOutputPath` pointer, or the `Full output saved to:` marker. A transcript is untrusted
input: a shared or imported session could declare any file you can read, such as an SSH key.

agent-lens dereferences a declared path only when it realpath-resolves inside the transcript root
or the archive (`src/archive/paths.ts`, `isUnderAnyRoot`). Resolving before the check is what makes
a symlink that escapes through either root count as outside. When only the sealed `.zst` twin of
the path exists, the twin must realpath-resolve inside those roots too.

The check runs twice: at projection time, before a path is persisted into the index
(`src/transcript/spill.ts`), and again at serve time, before `GET /api/events/:id/content` reads a
recorded path (`src/content/resolve.ts`) — so rows written before the check existed cannot serve
out-of-root bytes either. A declared path outside the roots degrades to the existing
"full output no longer on disk" state: never an error, and never a served file.

## What agent-lens never does

- It never writes to `~/.claude/projects`. The archive is a one-way read; a source file is never
  modified, moved or deleted by this tool.
- It never modifies your harness configuration. `agent-lens doctor` reports Claude Code's retention
  setting and repairs nothing.
- It never sends anything off the machine. There is no telemetry, no remote endpoint, and no
  network dependency at runtime.
- It never overwrites archived bytes that disagree with their source. Divergence is recorded, not
  resolved.

## Handling the archive

`~/.agent-lens/archive` is a verbatim copy of your transcripts. Anything you would not put in a
public place does not belong in a backup you would put in a public place either. Back it up, but
back it up somewhere you would back up the source code it quotes.
