// The schema contract module: entity types, the bundled pricing table, and the
// local auth-token helper. Imported by the server (types also by the UI). Zero
// runtime dependencies — Node builtins only.
//
// The envelope and event-id halves went with the hook path in Task 4.5: v2 reads
// transcripts, so there is no envelope to shape and no id to derive. Task 5.1
// then dropped the seven entity types that went with them, and Task 5.2 dropped
// the eight that described the plan-001 span tree.

export { estimateCost } from './pricing.js';

export { readOrCreateToken, readToken, TOKEN_HEADER } from './token.js';
