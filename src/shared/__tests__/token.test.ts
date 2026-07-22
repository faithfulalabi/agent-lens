import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrCreateToken, readToken } from '../token.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-lens-token-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readOrCreateToken', () => {
  it('creates the token file with 0600 permissions', () => {
    const token = readOrCreateToken(dir);
    const tokenPath = join(dir, 'token');
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
    // Entropy sanity: base64url of 32 bytes is ~43 chars.
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('reads the existing token without overwriting on a second call', () => {
    const first = readOrCreateToken(dir);
    const second = readOrCreateToken(dir);
    expect(second).toBe(first);
  });

  it('regenerates a new distinct token when the file is deleted', () => {
    const first = readOrCreateToken(dir);
    rmSync(join(dir, 'token'));
    const second = readOrCreateToken(dir);
    expect(second).not.toBe(first);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp files behind after an atomic write', () => {
    readOrCreateToken(dir);
    const leftovers = readdirSync(dir).filter((name) => name !== 'token');
    expect(leftovers).toEqual([]);
  });

  it('creates the directory if it does not yet exist', () => {
    const nested = join(dir, 'sub', 'nested');
    const token = readOrCreateToken(nested);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(existsSync(join(nested, 'token'))).toBe(true);
  });
});

describe('readToken', () => {
  it('returns the token when present', () => {
    const created = readOrCreateToken(dir);
    expect(readToken(dir)).toBe(created);
  });

  it('returns null when the token file is missing', () => {
    expect(readToken(dir)).toBeNull();
  });
});
