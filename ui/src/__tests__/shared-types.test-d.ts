// Compile-only assertion: the UI can import shared entity types via the
// `@shared` alias and they type-check in the browser (bundler) context.
// Vite/tsc strip these type-only imports at build time — no Node builtins leak
// into the browser bundle. This file emits no runtime code.

import type { Span, Trace, Session, Message } from '@shared/entities.ts';

// Force the compiler to resolve and structurally check each imported type.
// If the alias broke or a field were removed, `tsc --noEmit` would fail here.
type _AssertSpan = Span['span_type'] extends
  | 'llm_call'
  | 'tool_call'
  | 'thinking'
  | 'subagent'
  | 'generic'
  ? true
  : never;

type _AssertTrace = Trace['id'] extends string ? true : never;
type _AssertSession = Session['capture_mode'] extends 'full' | 'transcript_only'
  ? true
  : never;
type _AssertMessage = Message['role'] extends string ? true : never;

export type SharedTypesResolve = [
  _AssertSpan,
  _AssertTrace,
  _AssertSession,
  _AssertMessage,
];
