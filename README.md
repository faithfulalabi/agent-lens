# agent-lens

A local-first tracing platform for coding agents. Run one command, open a local UI, and read back
everything a Claude Code session did — prompts, tool calls, sub-agents, inputs and outputs — so you
can see where a session went and steer the next one better.

It reads the transcripts Claude Code already writes to disk. There is nothing to add to your
harness and nothing to configure.

## Quickstart

```bash
npx agent-lens
```

That starts the local server and the UI and prints the URL. Open it. Sessions you have already run
are there; new ones show up as they happen.

Requires Node.js `>=24`.

## The durability contract — read this before you delete anything

Three directories, three completely different promises.

| Path                     | What it is                                                                                                            | What deleting it costs                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `~/.claude/projects`     | The **source**. Claude Code owns it, writes it, and expires files from it on its own schedule. agent-lens only reads. | Not your call — Claude Code is already doing it. That is the whole reason this tool exists. |
| `~/.agent-lens/archive`  | The **system of record**. A verbatim mirror: the same bytes at a different path, append-only, never written back.     | **Everything past the source's cliff.** There is no other copy.                             |
| `~/.agent-lens/cache.db` | A **disposable** cache — search indexes and projections, all derived.                                                 | Nothing. It rebuilds from the archive.                                                      |

> **rm cache.db loses nothing. rm -rf ~/.agent-lens/archive loses data permanently.**

The inversion is the point. The directory that looks canonical is the one being erased, and the
unremarkable one in your home directory is the one holding the only surviving copy.

### The limitation, stated plainly

> **agent-lens can only archive what exists while it runs — a gap in uptime is a gap in the record.**

A coverage figure of 100% is 100% _of the survivors_. Anything Claude Code expired before the
archive existed, or during a long gap in it, is gone and no tool can bring it back.

What the archive does hold, it holds forever. The shape is consistent even though the numbers are
not: the source thins out with age and then stops — past a cliff a few weeks back there is nothing
left in it at all — while the archive keeps going. Every session older than that cliff exists only
in the archive.

Do not take a number from this page. Your corpus is not the author's, and both move day to day.
`agent-lens doctor` prints yours, including how many files have no live source left and are held
only by the archive.

## Keeping the archive current

Run `agent-lens archive` on a schedule, using whatever your OS already provides — a launchd agent
on macOS, a systemd timer or cron elsewhere. It is safe to run often: an advisory lock means a
second concurrent pass copies nothing and exits 0, an unchanged corpus copies zero bytes, and a
pass with nothing to report writes no log line.

One caveat worth knowing before you rely on an interval: a wall-clock schedule does not fire while
the machine is asleep. Treat the interval as a bound on _wake_ time, not on elapsed time.

| Flag                     | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `--json`                 | emit the full pass report (the stable contract for `doctor`) |
| `--dataDir <dir>`        | override `~/.agent-lens`                                     |
| `--transcriptRoot <dir>` | override `~/.claude/projects`                                |
| `--verify`               | full-file integrity audit — **not for the scheduled pass**   |

Each pass compares a 4 KB head and a 4 KB seam per file, roughly 1% of the corpus by bytes: enough
to catch a rewritten file at the point an append would splice onto it, and deliberately not a full
integrity check. `--verify` re-reads every archived file and its source in full. It is the real
audit and it costs a read of the entire corpus, so run it by hand or on a weekly schedule, never on
the frequent one.

When a source has been rewritten — it shrank, or its head or seam changed — the archived bytes are
**kept** and the file is marked `diverged` rather than overwritten, and the event is recorded in
`~/.agent-lens/logs/archive.jsonl`.

## `agent-lens doctor` — what is protected, and what is not

`doctor` reads both trees and reports archive coverage, integrity, total archive bytes split hot vs
sealed, every diverged file, and Claude Code's own retention setting. It **writes nothing** — not
the archive, not the log, not the lock, and never anything belonging to your harness. It reports
retention; it does not repair it.

```bash
agent-lens doctor --verify
```

| Flag                     | Meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `--json`                 | emit the full report as one JSON line                                                         |
| `--dataDir <dir>`        | override `~/.agent-lens`                                                                      |
| `--transcriptRoot <dir>` | override `~/.claude/projects`                                                                 |
| `--settingsPath <file>`  | override where the harness retention setting is read from (also `AGENT_LENS_CLAUDE_SETTINGS`) |
| `--verify`               | recompute the full prefix hash — the real audit, not the sampled one                          |

Read the integrity line carefully. It prints three counts that sum to the number of archived files:
**verified**, **diverged** and **unverifiable**. A file is unverifiable when nothing exists to check
it against — its source has already expired, or it is sealed — and there is no stored per-file hash
yet. Those files are never counted as verified. On a machine that has been off for a month, expect
unverifiable to be the large one. That is the truthful answer, not a failure.

`doctor` also reports the time since the archive job's last successful pass, read from the job's
own log (`~/.agent-lens/logs/cron.log`) and never from a file mtime — a job that has not run is a
different, more urgent fact than one that ran and found nothing new to copy.

## Starting the server

```bash
agent-lens start
```

| Flag            | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `--port <n>`    | bind port (auto-increments on collision)                                                                      |
| `--host <host>` | bind host. Defaults to loopback; anything else prints a network-exposure warning and is your decision to make |

The server binds `127.0.0.1` by default and every `/api/*` request carries a token. See
[SECURITY.md](SECURITY.md) for the trust boundary, including the one property that surprises
people: on a shared machine, the agent being traced can read the trace API too.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the render loop against a real corpus, and the
one-door rule every change to transcript reading has to satisfy.

## License

MIT.
