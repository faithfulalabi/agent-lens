import { useMemo, useState } from 'react';

import { createApiClient, type ApiClient, type SearchBody } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { emptyResultCopy, hitsBySession, searchIntent, type WarmState } from '@/lib/search';
import { SearchHitRow } from '@/components/session/SearchHitRow';
import { SearchScope } from '@/components/session/SearchScope';

/*
 * The search screen's page module (Task 7.2) — the screen at `/search` and
 * `/search/session/:id`.
 *
 * ===========================================================================
 * NO RENDER TEST TARGETS THIS FILE, AND THAT IS WHY IT DECIDES NOTHING.
 * ===========================================================================
 * `ui/vitest.config.ts` sets `environment: 'node'`: effects never fire and a
 * static render emits the pending branch alone. So every decision that could be
 * got wrong lives in `@/lib/search` as a pure function — the snippet split, the
 * scope sentence, the empty-state copy, the warm fold — and each surface below
 * is a props-in component with its own render assertions. What is left here is
 * state and wiring, which is all a module no test can reach should hold.
 *
 * ===========================================================================
 * THE SCOPE IS THE ROUTE'S, NOT A CONTROL'S.
 * ===========================================================================
 * `/search` searches every projected transcript and `/search/session/:id`
 * searches one, so the scope is addressable and reloadable rather than a piece
 * of state that evaporates on refresh. The answer's own `scope` field is what
 * the strip reports, never the prop — a screen that stated the scope it ASKED
 * for would keep saying it while the server answered something else.
 *
 * ===========================================================================
 * THE WARM COUNT COMES OFF EVERY SEARCH RESPONSE, AND NOT OFF A FRAME.
 * ===========================================================================
 * `unprojected_count` rides on every `/api/search` body, so re-running a query
 * refreshes the residual with no stream frame at all, and the control's own
 * `queued` answers the moment the POST returns. That is everything this task can
 * exercise end to end.
 *
 * ★ THIS PAGE TAKES NO BUS, DELIBERATELY. Task 7.4 owns the `warm_progress`
 * decode — the payload type, the `LiveFrame` arm and the `use-live.ts` limb are
 * all its commit, in the same change that ships the producer — so AC3's frame
 * clause is 7.4's to tick. `warmState` in `@/lib/search` is the fold that will
 * take those frames; it is unit-tested here and wired there. The pin at
 * `lib/__tests__/use-live.test.tsx:92` counts the pages the bus reaches and is
 * what holds that line.
 */

export interface SearchProps {
  /** Set by `/search/session/:id`. Absent means the whole projected corpus. */
  sessionId?: string;
  api?: ApiClient;
}

export function Search({ sessionId, api }: SearchProps = {}) {
  const client = useMemo(() => api ?? createApiClient(), [api]);

  const [raw, setRaw] = useState('');
  const intent = searchIntent(raw);

  /*
   * An idle query resolves to `null` rather than reaching the wire. The server
   * 400s an empty `q`, so firing one would spend the screen's first render on a
   * request it already knows is malformed — and `searchIntent` is where that
   * decision is asserted.
   */
  const state = useAsync<SearchBody | null>(
    `${intent.kind === 'idle' ? '' : intent.q}|${sessionId ?? ''}`,
    (signal) =>
      intent.kind === 'idle'
        ? Promise.resolve(null)
        : client.search(intent.q, sessionId === undefined ? {} : { session: sessionId }, {
            signal,
          }),
  );
  const body = state.kind === 'ok' ? state.value : null;

  const [warm, setWarm] = useState<WarmState | null>(null);

  const unprojected = body?.unprojected_count ?? 0;
  const groups = hitsBySession(body?.items ?? []);
  /*
   * Only once the answer is in hand. A query in flight has no hits YET, and
   * "no matches" is the one sentence this screen must never say about a
   * question it has not finished asking — it is the falsehood the whole design
   * is written against, just arriving 200ms early.
   */
  const empty =
    state.kind === 'ok' ? emptyResultCopy(intent, body?.items.length ?? 0, unprojected) : null;

  return (
    <main data-slot="search-view" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <input
          data-slot="search-input"
          type="search"
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
          }}
          placeholder="Search transcripts"
          aria-label="Search transcripts"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
        />
      </div>

      <SearchScope
        scope={body?.scope ?? null}
        unprojectedCount={unprojected}
        warm={warm}
        onWarm={() => {
          client
            .warm()
            .then(({ queued }) => {
              // The queue's own number, shown at once: the first progress frame
              // may be a whole session away, and a control that answered nothing
              // reads as a control that did nothing.
              setWarm({ done: 0, total: queued });
            })
            .catch(() => undefined);
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {state.kind === 'error' ? (
          <p className="text-sm text-error">{state.error.message}</p>
        ) : empty !== null ? (
          <p data-slot="search-empty" className="text-xs text-muted">
            {empty}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.sessionId} className="mb-3 flex flex-col gap-0.5">
              <h2 className="truncate px-2 text-2xs uppercase tracking-widest text-muted">
                {group.title ?? group.projectPath}
              </h2>
              {group.hits.map((hit) => (
                <SearchHitRow key={hit.event_id} hit={hit} />
              ))}
            </section>
          ))
        )}
      </div>
    </main>
  );
}
