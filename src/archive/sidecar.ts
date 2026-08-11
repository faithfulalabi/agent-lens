// The durable half of a seal. `sealArchiveFile` publishes one of these beside
// every `.zst` it creates, so the record that certifies a set of archived bytes
// sits on the same medium, in the same directory, and is lost only when they
// are. A field on `ArchiveLogRecord` or a column in `cache.db` would both have
// separated the two.
//
// This module is deliberately pure — it names no mutating fs call, only
// `readFileSync` — so the archive's "who may write" allowlist stays four
// filenames long and `seal.ts` remains the single place the publish ORDER is
// argued. Nothing in production reads a sidecar yet; `doctor` gains the
// comparison in task 1.8. The reader below ships now because it is the half
// that has to stay symmetric with the writer, and it is tested against it.

import { readFileSync } from 'node:fs';

/**
 * Appended to the sealed name, never to the logical one, so the pair is
 * `<file>.jsonl.zst` + `<file>.jsonl.zst.sha256`. `discover` cannot see the
 * second: `.sha256` is not `.zst`, so its sealed-suffix strip is a no-op and
 * the remaining name matches none of the allowed suffixes. That is what keeps
 * the sidecar out of `filesSeen` and out of `bytes.totalBytes`.
 */
const SIDECAR_SUFFIX = '.sha256';

/**
 * The compatibility gate. A reader that does not recognise the version must
 * decline rather than guess at the fields, which is why `readSidecar` returns
 * `undefined` for any other value instead of a partly-understood record.
 */
export const SIDECAR_VERSION = 1;

/** One line of JSON beside one sealed frame. */
export interface SealSidecar {
  v: number;
  /**
   * The basename, never an absolute path: relocating an archive root — by
   * symlink or by move — must not invalidate a hash that still describes the
   * bytes correctly.
   */
  file: string;
  /** sha256 over the PRE-seal plaintext, i.e. `SealResult.archive_sha256`. */
  sha256: string;
  /** Pre-seal length, pinned independently of the frame header. */
  hot_size: number;
  /** The `.zst`'s length, so a mismatch is decidable from a `stat` alone. */
  sealed_size: number;
  sealed_at: string;
}

/** Takes the SEALED path (`<archivePath>.zst`), so a `.zst` locates its own record. */
export function sidecarPath(sealedPath: string): string {
  return `${sealedPath}${SIDECAR_SUFFIX}`;
}

/** Newline-terminated, so a truncated tail is visible as a parse failure. */
export function serializeSidecar(record: SealSidecar): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * `undefined` for every expected condition — absent, unreadable, truncated,
 * malformed, or a version this build does not know — and never a throw. A
 * missing or unusable sidecar is the legacy case, not an error, and the caller
 * must not have to tell those apart before it can classify the file.
 */
export function readSidecar(path: string): SealSidecar | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isSealSidecar(parsed) ? parsed : undefined;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

function isSealSidecar(value: unknown): value is SealSidecar {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Record<keyof SealSidecar, unknown>>;
  return (
    record.v === SIDECAR_VERSION &&
    typeof record.file === 'string' &&
    typeof record.sha256 === 'string' &&
    HEX_SHA256.test(record.sha256) &&
    Number.isInteger(record.hot_size) &&
    Number.isInteger(record.sealed_size) &&
    typeof record.sealed_at === 'string'
  );
}
