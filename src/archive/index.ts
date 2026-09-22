// Public surface of the archive. Nothing here may reach `src/db/**`,
// `src/server/**` or `src/capture/**`, transitively included.

export { archiveOnce, createMirrorContext, mirrorFile } from './mirror.js';
export type { ArchiveResult } from './mirror.js';
export { discover } from './discover.js';
export type { DiscoveredEntry } from './discover.js';
export { buildDoctorReport, SEALED_LEGACY_REASON } from './report.js';
export type { DoctorReport, RetentionSetting } from './report.js';
export { acquireLock } from './lock.js';
export { parseCronLog, readCronLogStatus } from './cron-log.js';
export type { LastPassReport } from './cron-log.js';
export {
  resolveArchiveLogPath,
  resolveArchiveRoot,
  resolveCronLogPath,
  resolveDataDir,
  resolveLockPath,
  resolveTranscriptRoot,
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
