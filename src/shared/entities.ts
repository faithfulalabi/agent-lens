// Type-only entity definitions mirroring `spec/data-model.md` §Entities verbatim.
// Type-only (interfaces + string-literal unions) so importing from the browser
// (ui/) costs nothing at runtime and leaks no Node builtins into the bundle.
//
// EIGHT MORE TYPES WENT IN TASK 5.2: Session, Span, Trace and the five unions
// that keyed them. The v2 wire carries `TurnRow` and `EventRow` (ui/src/lib/
// api.ts) and the session tree is now built straight off them, so the plan-001
// adapter that constructed these — and the forest builder that walked them —
// went with the screen that rendered them. `SessionStatus` and `CaptureMode`
// STAY: `session-visuals.ts` keys its two manifests on them.

/** Session lifecycle status (data-model §Session). */
export type SessionStatus = 'live' | 'complete' | 'interrupted';

/** How much of a session was captured (data-model §Session). */
export type CaptureMode = 'full' | 'transcript_only';
