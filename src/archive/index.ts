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
  SEALED_REASON,
} from './report.js';
export type {
  ArchiveBytes,
  CoverageStats,
  DivergedFile,
  DoctorReport,
  DoctorReportOptions,
  IntegrityResults,
  RetentionSetting,
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
