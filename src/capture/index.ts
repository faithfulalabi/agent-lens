// Capture pipeline: normalizer, merge policy, transcript tailer, spool replay.
// Pure logic, no HTTP. Filled in from Phase 2 onward. Placeholder export.
export const MODULE = 'capture';

export { normalize, mapToolStatus } from './normalizer.js';
export type { NormalizeResult } from './normalizer.js';
export { reprocessDeadLetters } from './reprocess.js';
export type { ReprocessResult } from './reprocess.js';
export {
  sweepInactive,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
} from './inactivity.js';
export type { SweepOptions, SweepResult } from './inactivity.js';
