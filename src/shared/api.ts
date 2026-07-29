// Read-API wire shapes that are NOT raw entities (Task 5.0). Type-only, so the
// browser can import it for free — a sibling of `entities.ts` and, like it, the
// contract Task 5.1c's typed client is written against.
//
// **Deliberately NOT re-exported from `src/shared/index.ts`.** That barrel pulls
// in `token.js` (`node:crypto`/`fs`/`os`/`path`) and `pricing.js` (`node:crypto`),
// so anything browser-facing must be imported from this module directly —
// `import type { Page } from '@shared/api.js'` — the way
// `ui/src/__tests__/shared-types.test-d.ts` imports `@shared/entities.js`.

import type { Session, Trace } from './entities.js';

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

/**
 * `GET /api/sessions/:id` — the session summary plus its traces.
 *
 * The trace list is a nested `Page<Trace>` rather than a bare array: a session's
 * turn count is unbounded, and an unpaginated array here would be a second,
 * implicit paging scheme. Same `?limit`/`?offset` params as every other list.
 */
export interface SessionDetail {
  session: Session;
  traces: Page<Trace>;
}

/**
 * `GET /api/payloads/:id[?range=start-end]` — a payload slice with the metadata
 * the UI needs to decide whether to offer "Show full".
 *
 * Always HTTP 200 with this JSON body — never a 206, never raw bytes.
 * `byte_size` is the FULL stored size; `range` is the clamped, actually-served
 * interval (`end` inclusive, RFC 9110 convention); `truncated` says the two
 * disagree. `content` is UTF-8 decoded non-fatally, so a range that splits a
 * multi-byte sequence yields U+FFFD at the seam rather than an error.
 */
export interface PayloadSlice {
  id: string;
  byte_size: number;
  mime_hint?: string;
  range: { start: number; end: number };
  content: string;
  truncated: boolean;
}
