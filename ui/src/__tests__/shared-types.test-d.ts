// Compile-only assertion: the UI can import the shared types via the `@shared`
// alias, and the v2 wire rows type-check in the browser (bundler) context.
// Vite/tsc strip these type-only imports at build time — no Node builtins leak
// into the browser bundle. This file emits no runtime code.
//
// Task 5.2 repointed the second half. `Span`, `Trace` and `Session` were plan
// 001's shapes and the screens no longer build them; what the browser actually
// consumes is `TurnRow` and `EventRow` off `GET /api/sessions/:id`. `tsc` is the
// only thing that reads this file — it is outside vitest's include — which is
// why the check has to live in a type position rather than in an assertion.

import type { CaptureMode, SessionStatus } from '@shared/entities.ts';
import type { EventRow, TurnRow } from '@/lib/api';

// Force the compiler to resolve and structurally check each imported type.
// If the alias broke or a field were removed, `tsc --noEmit` would fail here.
type _AssertSessionStatus = SessionStatus extends 'live' | 'complete' | 'interrupted'
  ? true
  : never;
type _AssertCaptureMode = CaptureMode extends 'full' | 'transcript_only' ? true : never;

// The two fields Task 5.2 turned on: the fold predicate reads `parent_event_id`
// and the tool-call row reads `input`. Both are nullable, and a narrowing that
// forgot it would fail here.
type _AssertTurn = TurnRow['parent_event_id'] extends string | null ? true : never;
type _AssertEvent = EventRow['input'] extends string | null ? true : never;

// Task 5.3 widened the row again. The raw-JSON disclosure claims to render the
// stored record verbatim, and it cannot while the browser type drops a column
// `EVENT_COLUMNS` sends — so the presence of `spill_path` is a type-level fact.
type _AssertSpill = EventRow['spill_path'] extends string | null ? true : never;

export type SharedTypesResolve = [
  _AssertSessionStatus,
  _AssertCaptureMode,
  _AssertTurn,
  _AssertEvent,
  _AssertSpill,
];
