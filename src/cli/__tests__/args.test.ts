// Task 0.6 — the binary refuses any argument it does not recognise.
//
// ★ THE INCIDENT IS THE POINT OF THIS FILE. On 2026-08-09 `agent-lens archive
// --data-dir=… --transcript-root=…` ran two passes against the REAL data
// directory and exited 0, because a flag nothing matches is invisible to
// `parseStringFlag`. Describe 2 below is that exact invocation, and it asserts
// what was written, not merely the exit code.
//
// Harness split follows `archive.test.ts:1-11`: `validateArgs` is pure, so it
// gets unit tests; anything claiming what reached DISK drives `main` in-process
// with the resolver env pinned at a sandbox. Deliberately not the spawned
// binary — `bin/agent-lens.js` runs `dist/`, which `npm test` never builds.
//
// ⚠️ Every `main` row here is a REJECT row. That is what makes `start` safe to
// list: rejection happens before `match.run`, so `start()` never binds a socket
// and never awaits the signal promise that would hang this suite.

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  cleanup,
  jsonLines,
  makeSandbox,
  pinSandboxEnv,
  runMain,
  SLUG,
  snapshotTreeSafe,
  writeSource,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { validateArgs, type ArgSpec } from '../args.js';
import { EXIT_INCOMPLETE, parseStringFlag } from '../commands/archive.js';
import { COMMANDS } from '../index.js';
import { parsePort, parseHost } from '../commands/start.js';

const SESSION = `${SLUG}/sess-1.jsonl`;

let sandbox: Sandbox | undefined;
let restoreEnv: (() => void) | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/**
 * A sandbox with one archivable transcript, and the resolvers pinned at it, so
 * a command that ignores its flags still cannot reach a real `~/.agent-lens`.
 */
function seeded(): Sandbox {
  const s = sb();
  writeSource(s, SESSION, jsonLines(2));
  restoreEnv = pinSandboxEnv(s);
  return s;
}

const COMMAND_NAMES = ['start', 'doctor', 'archive', 'rebuild', 'warm', 'prune'];

// `--help` is a column here by founder ruling (OQ3, arm A): it is refused like
// any other unknown flag, and no per-command help renderer ships in 0.6.
// `agent-lens --help` in COMMAND position is untouched.
const UNKNOWN_FLAGS = ['--bogus', '--bogus=1', '--data-dir=/nope', '-x', '--help'];

describe('1 — every command refuses an argument it does not recognise (AC1, AC2)', () => {
  it.each(COMMAND_NAMES.flatMap((c) => UNKNOWN_FLAGS.map((f) => [c, f] as const)))(
    '%s %s exits 1, names the flag, and writes nothing',
    async (command, flag) => {
      const s = seeded();
      const before = snapshotTreeSafe(s.dataDir);

      const { code, err } = await runMain([command, flag]);

      // The side effect is asserted FIRST, and it is what matters for `--help`:
      // today `agent-lens archive --help` runs a real archive pass.
      expect([...snapshotTreeSafe(s.dataDir).keys()].sort()).toEqual([...before.keys()].sort());
      expect(code).toBe(EXIT_INCOMPLETE);
      expect(err).toContain(flag);
    },
  );
});

describe('1b — the did-you-mean clause suggests only on an exact normalised hit (OQ1)', () => {
  it('names --dataDir for --data-dir', async () => {
    seeded();
    const { err } = await runMain(['archive', '--data-dir=/nope']);
    expect(err).toContain('--dataDir');
  });

  it('never guesses for a flag that normalises to nothing known', async () => {
    seeded();
    const { err } = await runMain(['archive', '--totallyunrelated']);
    expect(err).not.toMatch(/did you mean/);
  });
});

describe('2 — the 2026-08-09 incident, as a named regression (AC3)', () => {
  it('archive --data-dir=… --transcript-root=… is refused and writes nothing', async () => {
    const s = seeded();
    const decoy = join(s.root, 'decoy');
    // `makeSandbox` creates only `sourceRoot`, so "still absent" is real.
    expect(snapshotTreeSafe(s.dataDir).size).toBe(0);

    const { code, err } = await runMain([
      'archive',
      `--data-dir=${decoy}`,
      `--transcript-root=${decoy}`,
    ]);

    // Asserted BEFORE the exit code: what reached disk is what the incident was
    // about. Today this gains `logs/archive.jsonl` and
    // `archive/<slug>/sess-1.jsonl`, and still reports success.
    expect([...snapshotTreeSafe(s.dataDir).keys()]).toEqual([]);
    expect(code).toBe(EXIT_INCOMPLETE);
    expect(err).toContain('--data-dir=');
  });
});

describe('6 — the one deliberate empty-value divergence (OQ5)', () => {
  it('start --port= is refused', async () => {
    // BEHAVIOUR CHANGE, ruled 2026-09-08. `parsePortValue` (`start.ts:52-57`)
    // reads `Number('') === 0` today, so `--port=` binds an ephemeral port.
    // `--port=0`, `--port 0` and `--port ''` all keep working.
    seeded();
    const { code, err } = await runMain(['start', '--port=']);
    expect(code).toBe(EXIT_INCOMPLETE);
    expect(err).toContain('--port requires a value');
  });

  it('archive --dataDir= keeps its verdict and loses its stack', async () => {
    seeded();
    const { code, err } = await runMain(['archive', '--dataDir=']);
    expect(code).toBe(EXIT_INCOMPLETE);
    expect(err).toContain('--dataDir requires a value');
  });
});

/** The shipped spec, never a hand-written copy — a copy could not drift-check. */
function specOf(name: string): ArgSpec {
  const match = COMMANDS.find((c) => c.name === name);
  if (match === undefined) throw new Error(`no such command: ${name}`);
  return match;
}

describe('4 — the positive control: every valid flag still parses (AC4)', () => {
  // Without this the fix could pass by rejecting everything. Both spellings of
  // every `value` flag, every `boolean` flag, and the dash-prefixed slug the
  // `parseStringFlag` docstring (`archive.ts:40-43`) exists for.
  const VALUE = '/tmp/x';

  it.each([
    ['start', ['--port', '4470', '--host', '0.0.0.0']],
    ['start', ['--port=4470', '--host=0.0.0.0']],
    ['start', ['--port', '0']],
    ['doctor', ['--dataDir', VALUE, '--transcriptRoot', VALUE, '--settingsPath', VALUE]],
    ['doctor', ['--dataDir=/x', '--transcriptRoot=/y', '--settingsPath=/z', '--verify', '--json']],
    ['archive', ['--dataDir', VALUE, '--transcriptRoot', VALUE]],
    ['archive', ['--dataDir=/x', '--transcriptRoot=/y', '--verify', '--json']],
    ['archive', ['--dataDir', '-Users-x-proj']],
    ['archive', ['--dataDir=-Users-x-proj']],
    ['rebuild', ['--dataDir', VALUE]],
    ['rebuild', ['abc', '--dataDir=/x']],
    ['warm', ['--dataDir', VALUE, '--transcriptRoot', VALUE]],
    ['warm', ['--dataDir=/x', '--transcriptRoot=/y']],
    ['prune', ['--dataDir', VALUE, '--transcriptRoot', VALUE, '--settingsPath', VALUE]],
    ['prune', ['--dataDir=/x', 'abc', '--transcriptRoot=/y']],
    ['prune', []],
  ])('%s %j is accepted', (command, args) => {
    expect(validateArgs(specOf(command), args)).toEqual({ ok: true });
  });

  it('the whole inventory still takes effect end to end', async () => {
    const s = seeded();

    const { code, out } = await runMain([
      'archive',
      '--dataDir',
      s.dataDir,
      '--transcriptRoot',
      s.sourceRoot,
      '--verify',
      '--json',
    ]);

    expect(code).toBe(0);
    // The flags reached the command: it mirrored into the SANDBOX.
    expect([...snapshotTreeSafe(s.dataDir).keys()]).toContain(`archive/${SESSION}`);
    expect(JSON.parse(out)).toMatchObject({ filesSeen: 1 });
  });
});

describe('5 — value consumption matches the parsers exactly (AC4, AC5)', () => {
  const archiveSpec = specOf('archive');

  it('consumes a space-separated value by position, and the parser agrees', () => {
    const args = ['--dataDir', '/tmp/x', '--verify'];
    expect(validateArgs(archiveSpec, args)).toEqual({ ok: true });
    expect(parseStringFlag(args, 'dataDir')).toBe('/tmp/x');
  });

  it('reproduces the documented swallow rather than correcting it', () => {
    // `doctor.test.ts:54-55` documents this: `parseStringFlag` takes `--verify`
    // as the value, AND `args.includes('--verify')` is still true.
    const args = ['--dataDir', '--verify'];
    expect(validateArgs(archiveSpec, args)).toEqual({ ok: true });
    expect(parseStringFlag(args, 'dataDir')).toBe('--verify');
    expect(args.includes('--verify')).toBe(true);
  });

  it('never reads a dash-prefixed value as a flag', () => {
    const args = ['--dataDir', '-Users-x-proj'];
    expect(validateArgs(archiveSpec, args)).toEqual({ ok: true });
    expect(parseStringFlag(args, 'dataDir')).toBe('-Users-x-proj');
  });

  it.each([
    [['--dataDir'], '--dataDir requires a value'],
    [['--dataDir='], '--dataDir requires a value'],
    [['--verify', '--dataDir'], '--dataDir requires a value'],
  ])('%j is refused with the parsers own wording', (args, message) => {
    expect(validateArgs(archiveSpec, args)).toEqual({ ok: false, message });
  });
});

describe('6b — the --port= change is confined to the = spelling (OQ5)', () => {
  // ⚠️ Asserted against `validateArgs`, never `main`: `main(['start','--port','0'])`
  // binds a socket and awaits a signal, which would hang this suite.
  it('the space form with an empty token still reaches parsePort as 0', () => {
    expect(validateArgs(specOf('start'), ['--port', ''])).toEqual({ ok: true });
    expect(parsePort(['--port', ''])).toBe(0);
  });

  it('--port 0 and --port=0 are both untouched', () => {
    expect(validateArgs(specOf('start'), ['--port', '0'])).toEqual({ ok: true });
    expect(validateArgs(specOf('start'), ['--port=0'])).toEqual({ ok: true });
    expect(parsePort(['--port=0'])).toBe(0);
  });

  it('leaves the per-parser contracts alone', () => {
    expect(parseHost(['--port', '4470'])).toBeUndefined();
  });
});

describe('7 — bare arguments land where each parser actually reads them (OQ4)', () => {
  it.each([
    ['start', ['/some/path']],
    ['doctor', ['/some/path']],
    ['archive', ['/some/path']],
    ['warm', ['/some/path']],
  ])('%s takes no positional at all', (command, args) => {
    expect(validateArgs(specOf(command), args)).toEqual({
      ok: false,
      message: 'unexpected argument /some/path',
    });
  });

  it.each([[['--dataDir=/x', 'abc']], [['--dataDir', '/x', 'abc']]])(
    'rebuild accepts %j — the id lands at any index, as prune already allows (task 0.15)',
    (args) => {
      expect(validateArgs(specOf('rebuild'), args)).toEqual({ ok: true });
    },
  );

  it('a second bare id is a count problem, and says so', () => {
    expect(validateArgs(specOf('rebuild'), ['abc', 'def'])).toEqual({
      ok: false,
      message: 'unexpected argument def — rebuild takes at most one session id',
    });
  });

  it('prune keeps its documented at-any-index id, and still refuses a second', () => {
    // `parsePruneArgs` accepts it after a flag and `prune.test.ts:324` pins that,
    // so a stricter binary-wide rule would newly refuse a committed invocation.
    expect(validateArgs(specOf('prune'), ['--dataDir=/x', 'abc'])).toEqual({ ok: true });
    expect(validateArgs(specOf('prune'), ['one', 'two'])).toEqual({
      ok: false,
      message: 'unexpected argument two — prune takes at most one session id',
    });
  });
});

describe('8 — the failure is one actionable line, never a stack (AC6)', () => {
  it.each([['--bogus'], ['--dataDir='], ['--dataDir']])('archive %s', async (flag) => {
    seeded();

    const { code, err } = await runMain(['archive', flag]);

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(err.split('\n')).toHaveLength(1);
    expect(err).toContain('agent-lens archive');
    expect(err).not.toMatch(/\n\s+at /);
  });
});
