// Read-API wire shapes that are NOT raw entities (Task 5.0). Type-only, so the
// browser can import it for free — a sibling of `entities.ts` and, like it, the
// contract Task 5.1c's typed client is written against.
//
// **Deliberately NOT re-exported from `src/shared/index.ts`.** That barrel pulls
// in `token.js` (`node:crypto`/`fs`/`os`/`path`) and `pricing.js` (`node:crypto`),
// so anything browser-facing must be imported from this module directly —
// `import type { Page } from '@shared/api.js'` — the way
// `ui/src/__tests__/shared-types.test-d.ts` imports `@shared/entities.js`.
//
// `SessionDetail` and `PayloadSlice` went in Task 5.1. Both described routes
// task 4.5 deleted, nothing constructed either, and they carried this module's
// only entity import.

/**
 * The one pagination envelope, identical on every list the read API serves.
 *
 * `has_more` comes from a `LIMIT n+1` probe, not a `COUNT(*)`: a count is a
 * second query with a read-time aggregate, which is exactly what the Flow 3
 * "rollups at write time" bet forbids. There is deliberately no `total`.
 */
export interface Page<T> {
  items: T[];
  /** The effective limit after clamping to `MAX_LIMIT`. */
  limit: number;
  offset: number;
  has_more: boolean;
}
