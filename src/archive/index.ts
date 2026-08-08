// Public surface of the archive. Nothing here may reach `src/db/**`,
// `src/server/**` or `src/capture/**` — transitively, not just textually — so
// `agent-lens archive` can run on a cron before the rest of the product exists.
// `__tests__/source-readonly.test.ts` enforces that at both the static and the
// runtime level.

export { archiveOnce, createMirrorContext, decideCopyEnd, mirrorFile } from './mirror.js';
export type {
  ArchiveFileState,
  ArchiveOptions,
  ArchiveResult,
  ArchiveState,
  DivergenceReason,
  MirrorContext,
  SourceState,
} from './mirror.js';
export { discover } from './discover.js';
export type { DiscoveredEntry } from './discover.js';
export { acquireLock, releaseLock, MAX_LOCK_AGE_MS } from './lock.js';
export type { Lock, LockIdentity, LockState, ReclaimReason } from './lock.js';
export { appendArchiveLog, isQuiet } from './log.js';
export type { ArchiveLogRecord, DivergedLogEntry } from './log.js';
export {
  resolveArchiveLogPath,
  resolveArchiveRoot,
  resolveDataDir,
  resolveLockPath,
  resolveTranscriptRoot,
  canonicalizeTranscriptPath,
} from './paths.js';
