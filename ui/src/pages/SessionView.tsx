import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import {
  createApiClient,
  type ApiClient,
  type ContentField,
  type EventContentBody,
  type EventRow,
} from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { buildTurnGroups, flatten } from '@/lib/turn-tree';
import {
  initialExpanded,
  loadSessionDetail,
  needsReseed,
  rowsChangedAction,
  type SessionData,
} from '@/lib/session-data';
import { initialNavState, navReducer, type NavAction, type NavState } from '@/lib/tree-nav';
import { buildThread, type SessionViewMode } from '@/lib/thread';
import { EventDetail } from '@/components/session/EventDetail';
import { SessionHeader } from '@/components/session/SessionHeader';
import { SpanTree } from '@/components/session/SpanTree';
import { ThreadView } from '@/components/session/ThreadView';
import { TruncationNotice } from '@/components/session/TruncationNotice';

/*
 * The session view's page module (Task 5.3b) — the screen at `/session/:id`.
 *
 * ===========================================================================
 * NO RENDER TEST TARGETS THIS FILE, AND THAT IS WHY IT DECIDES NOTHING.
 * ===========================================================================
 * Its data arrives through an effect, and the `ui` project runs under
 * `environment: 'node'` where effects never fire — a static render of this
 * component emits its pending branch and nothing else. So every decision that
 * could be got wrong lives somewhere a unit test can reach it: the fetch loop,
 * the opening expansion state, the truncation copy and the navigation action
 * are all in `@/lib/session-data`; the row model is `@/lib/turn-tree`; the
 * keyboard is `@/lib/tree-nav`; and every surface on screen below is a props-in
 * component with its own render assertions. What is left here is wiring.
 *
 * ===========================================================================
 * THE API CLIENT IS A PROP.
 * ===========================================================================
 * `createApiClient()`'s default reads the page bootstrap, and that read THROWS
 * outside a browser. A memo does not save you — it runs during render, so
 * "lazy" defers the throw by exactly nothing. Without an injectable client the
 * `<App />` render at `/session/x` could not exist. The session list next door
 * carries the same prop for the same reason.
 *
 * ===========================================================================
 * THE NAVIGATION STATE IS SEEDED DURING RENDER, NOT IN AN EFFECT.
 * ===========================================================================
 * The opening expansion set depends on data that has not arrived at mount, and
 * `navReducer` has no action for "start again with these turns open" — nor
 * should it, since that is a load event rather than a keystroke. React's own
 * answer to state that has to follow a prop is to adjust it during render and
 * let the component re-render immediately, which is what happens below. An
 * effect would paint one frame with every turn closed first.
 */

/**
 * The keystrokes the tree answers, so everything else reaches the browser.
 *
 * The list mirrors `navReducer`'s own switch. Stated here rather than imported
 * because the reducer answers by returning state, not by reporting whether it
 * recognised the key — and a handler that called `preventDefault` on every
 * keystroke would stop tab leaving the tree.
 */
const TREE_KEYS = new Set([
  'j',
  'k',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Enter',
  'Escape',
]);

export interface SessionViewProps {
  sessionId: string;
  api?: ApiClient;
}

export function SessionView({ sessionId, api }: SessionViewProps) {
  const client = useMemo(() => api ?? createApiClient(), [api]);

  /*
   * One clock reading, taken once, for the one surface that needs one: a live
   * session's header has no `ended_at` to close its elapsed time against. The
   * tree below reads no clock at all — an event carries the duration the
   * projector measured. Task 6.2 owns the ticking.
   */
  const [now] = useState(() => Date.now());

  const state = useAsync<SessionData>(sessionId, (signal) =>
    loadSessionDetail(client, sessionId, { signal }),
  );
  const data = state.kind === 'ok' ? state.value : null;

  const [nav, setNav] = useState<NavState>(() => initialNavState());
  const dispatch = useCallback((action: NavAction) => {
    setNav((current) => navReducer(current, action));
  }, []);

  /*
   * Adjusted during render, per the header note. `seededFor` is the session the
   * current navigation state belongs to, so a different session starts over and
   * a re-render of the same one does not.
   *
   * The comparison is `needsReseed`'s and not this file's, because getting it
   * wrong is invisible here: keying it on the `sessionId` PROP rather than on
   * the session that actually arrived is off by one render, and the symptom is
   * a session opening fully closed after a browser Back. See its own header.
   */
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (needsReseed(data, seededFor) && data !== null) {
    setSeededFor(data.session.id);
    setNav(initialNavState(initialExpanded(data.turns)));
  }

  const model = useMemo(
    () => buildTurnGroups(data?.turns ?? [], data?.eventsByTurn ?? new Map()),
    [data],
  );
  const rows = useMemo(() => flatten(model, nav.expandedIds), [model, nav.expandedIds]);

  /*
   * The second reader over the SAME array. `useAsync` reads its loader through a
   * ref and keys its effect on the session id, so switching surfaces re-renders
   * and issues no further request — which is the whole of AC1.
   *
   * Local state rather than a route: a route needs `route-match.ts`, which is
   * under a standing do-not-touch rule and reserves query state for Task 7.2.
   */
  const [view, setView] = useState<SessionViewMode>('tree');
  const thread = useMemo(() => buildThread(data?.events ?? []), [data]);

  /*
   * The one action no keystroke produces. `modelIds` is the model's own id set
   * rather than the on-screen rows', which is what keeps a selection sitting
   * under a closed turn alive — and it is the contract Task 6.2's live append
   * turns on. `onRowsChanged` returns the same state when nothing moved, so
   * this settles in one pass rather than looping.
   */
  useEffect(() => {
    dispatch(rowsChangedAction(model, rows));
  }, [dispatch, model, rows]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // A modified keystroke belongs to the browser — cmd-left is Back, and a
      // tree that swallowed it would be a trap rather than a shortcut.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!TREE_KEYS.has(event.key)) return;
      // Only for the keys the reducer answers, so tab still leaves the tree and
      // the arrows do not scroll the page out from under the row they moved to.
      event.preventDefault();
      dispatch({ type: 'key', key: event.key, rows });
    },
    [dispatch, rows],
  );

  /*
   * The pointer's two gestures, written out rather than routed through the
   * keyboard reducer.
   *
   * A click carries its own target, while every reducer action is relative to
   * where focus already is — so expressing "select THIS row" as a keystroke
   * would mean walking focus there first, which is a worse description of what
   * the user did and a worse thing to read.
   */
  const onSelect = useCallback(
    (id: string) => {
      setNav((current) => {
        const index = rows.findIndex((row) => row.id === id);
        return index === -1 ? current : { ...current, focusedIndex: index, selectedId: id };
      });
    },
    [rows],
  );

  /*
   * The refetched body, and the three lines of wiring that ask for one.
   *
   * One slot rather than a map: the pane shows one event at a time, and
   * `contentStateOf` ignores a body that does not name the event and the field
   * it was asked about — so a stale answer arriving after the selection moved
   * is dropped by the decision rather than guarded against here. A failure
   * leaves the preview standing, which is the whole error handling this task
   * ships: the async matrix was cut.
   */
  const [fetched, setFetched] = useState<EventContentBody | null>(null);
  const onShowFull = useCallback(
    (id: string, field: ContentField) => {
      client
        .getEventContent(id, field)
        .then(setFetched)
        .catch(() => undefined);
    },
    [client],
  );

  const selectedEvent = useMemo<EventRow | null>(() => {
    const row = rows.find((candidate) => candidate.id === nav.selectedId);
    return row === undefined || row.kind !== 'event' ? null : row.node.event;
  }, [rows, nav.selectedId]);

  const onToggle = useCallback((id: string) => {
    setNav((current) => {
      const expandedIds = new Set(current.expandedIds);
      if (!expandedIds.delete(id)) expandedIds.add(id);
      return { ...current, expandedIds };
    });
  }, []);

  if (state.kind === 'error') {
    return (
      <main className="p-6">
        <p className="text-sm text-error">{state.error.message}</p>
      </main>
    );
  }

  return (
    <main data-slot="session-view" className="flex h-full min-h-0 flex-col">
      {data === null ? null : (
        <SessionHeader session={data.session} now={now} view={view} onViewChange={setView} />
      )}
      {data === null ? null : (
        <TruncationNotice
          shown={data.shown}
          hasMore={data.hasMore}
          unmatchedEventCount={model.unmatchedEventCount}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {view === 'thread' && data !== null ? (
          <ThreadView rows={thread} startedAt={data.session.started_at} />
        ) : (
          <>
            <div data-slot="tree-pane" className="min-w-0 flex-1 border-r border-border">
              <SpanTree
                rows={rows}
                selectedId={nav.selectedId}
                focusedIndex={nav.focusedIndex}
                onKeyDown={onKeyDown}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </div>

            <EventDetail event={selectedEvent} fetched={fetched} onShowFull={onShowFull} />
          </>
        )}
      </div>
    </main>
  );
}
