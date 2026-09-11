// `parseCronLog` and `readCronLogStatus` — the reader behind doctor's
// "time since the last successful pass". Every fixture line mimics the wrapper's
// real output: `<ISO8601, colon-less offset> <status-token> <first line of $OUT>`,
// with unprefixed continuation lines below some entries. The parser must key on
// the status token and never on `bytes copied`: a pass that ran and copied
// nothing is the healthy steady state.

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCronLog, readCronLogStatus, resolveCronLogPath } from '../index.js';
import { cleanup, makeSandbox } from './fixtures.js';

const REAL_SHAPED = [
  '2026-08-12T21:44:23-0500 ok   agent-lens archive: 538 files, 128352 bytes copied',
  '2026-08-12T21:44:48-0500 ERR127 env: node: No such file or directory',
  '2026-08-29T03:39:58-0500 ok   agent-lens archive: 691 files, 0 bytes copied',
  '  61 expired at the source — the archive is now the only copy',
  '2026-08-29T03:55:01-0500 FATAL repo missing: /Users/dev/agent-lens',
  '2026-08-29T04:10:12-0500 ERR3 archive-side errors — agent-lens archive: 691 files, 0 bytes copied, 1 error',
].join('\n');

describe('parseCronLog', () => {
  it('returns one entry per timestamped line and skips continuation lines', () => {
    const entries = parseCronLog(`${REAL_SHAPED}\n`);

    expect(entries.map((e) => e.status)).toEqual(['ok', 'ERR127', 'ok', 'FATAL', 'ERR3']);
    expect(entries[0]?.summary).toBe('agent-lens archive: 538 files, 128352 bytes copied');
    expect(entries[3]?.summary).toBe('repo missing: /Users/dev/agent-lens');
  });

  it('is pure over junk: blank lines, prose and truncated stamps parse to nothing', () => {
    const junk = '\n\nnot a log line\n2026-08-12 ok no T separator\n  188 expired at the source\n';
    expect(parseCronLog(junk)).toEqual([]);
    expect(parseCronLog('')).toEqual([]);
  });

  it.each([
    // The wrapper's offset has no colon, so the epoch is built by hand — never
    // handed to `new Date()`. Cross-checked against manually computed UTC values.
    ['2026-08-12T21:44:23-0500 ok x', Date.UTC(2026, 7, 13, 2, 44, 23)],
    ['2026-08-12T21:44:23+0000 ok x', Date.UTC(2026, 7, 12, 21, 44, 23)],
    ['2026-08-12T21:44:23+0530 ok x', Date.UTC(2026, 7, 12, 16, 14, 23)],
  ])('computes a comparable epoch from %s', (line, epochMs) => {
    expect(parseCronLog(line)).toEqual([{ epochMs, status: 'ok', summary: 'x' }]);
  });
});

describe('readCronLogStatus', () => {
  function withSandbox(run: (dataDir: string, path: string) => void): void {
    const s = makeSandbox();
    try {
      run(s.dataDir, resolveCronLogPath(s.dataDir));
    } finally {
      cleanup(s);
    }
  }

  function writeLog(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  it('reports `absent` when no cron.log exists — a job that never ran', () => {
    withSandbox((dataDir, path) => {
      expect(readCronLogStatus(dataDir)).toEqual({ state: 'absent', path });
      expect(path).toBe(join(dataDir, 'logs', 'cron.log'));
    });
  });

  it('reports `empty` for a file with no parseable entry — distinct from never ran', () => {
    withSandbox((dataDir, path) => {
      writeLog(path, '\n  a continuation line with no parent\n');
      expect(readCronLogStatus(dataDir)).toEqual({ state: 'empty', path });
    });
  });

  it('reports the most recent entry and the most recent ok, which can differ', () => {
    withSandbox((dataDir, path) => {
      writeLog(path, `${REAL_SHAPED}\n`);
      const report = readCronLogStatus(dataDir);

      expect(report.state).toBe('found');
      if (report.state !== 'found') return;
      expect(report.lastEntry.status).toBe('ERR3');
      expect(report.lastOk?.epochMs).toBe(Date.UTC(2026, 7, 29, 8, 39, 58));
      expect(report.lastOk?.summary).toContain('0 bytes copied');
    });
  });

  it('carries `lastOk` undefined when the job has run but never succeeded', () => {
    withSandbox((dataDir, path) => {
      writeLog(path, '2026-08-12T21:44:48-0500 ERR127 env: node: No such file or directory\n');
      const report = readCronLogStatus(dataDir);

      expect(report.state).toBe('found');
      if (report.state !== 'found') return;
      expect(report.lastOk).toBeUndefined();
      expect(report.lastEntry.status).toBe('ERR127');
    });
  });
});
