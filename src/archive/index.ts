// Public surface of the archive. Nothing here may reach `src/db/**`,
// `src/server/**` or `src/capture/**`, transitively included.

export {
  archiveOnce,
  createMirrorContext,
  decideCopyEnd,
  detectDivergence,
  mirrorFile,
  shouldSeal,
} from './mirror.js';
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
export { sealArchiveFile } from './seal.js';
export type { SealResult } from './seal.js';
export { createArchiveReader } from './read.js';
export type { ArchiveReader, ArchiveReaderStats } from './read.js';
export {
  buildDoctorReport,
  resolveClaudeSettingsPath,
  NO_LIVE_SOURCE_REASON,
  SEALED_LEGACY_REASON,
  SEALED_UNCHECKED_REASON,
} from './report.js';
export type {
  ArchiveBytes,
  CoverageStats,
  DivergedFile,
  DoctorReport,
  DoctorReportOptions,
  IntegrityResults,
  RetentionSetting,
  SealedDivergenceReason,
  UnverifiableFile,
} from './report.js';
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
// The two containment guards, published for `agent-lens prune` — the one command
// that deletes. `assertNotUnderRoot` is the load-bearing half: it is what stands
// between a destructive command and `~/.claude/projects`. Both labels ship with
// them so a caller cannot invent a third name for the same root.
export {
  assertNotUnderRoot,
  assertUnderRoot,
  DATA_DIR_LABEL,
  TRANSCRIPT_ROOT_LABEL,
} from './paths.js';
