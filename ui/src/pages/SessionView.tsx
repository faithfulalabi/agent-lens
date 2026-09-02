import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

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
  EVENT_LIMIT,
  initialExpanded,
  loadSessionDetail,
  needsReseed,
  revealTarget,
  rowsChangedAction,
  type SessionData,
} from '@/lib/session-data';
import { revealStep, type RevealLatch } from '@/lib/search';
import {
  applyFrame,
  atBottom,
  decideFrame,
  followReducer,
  initialFollowState,
  overlayData,
  pillLabel,
  type LiveBus,
  type Overlay,
  type ScrollMetrics,
} from '@/lib/live';
import {
  childIdsToFetch,
  initialSubagentState,
  subagentReducer,
  subtreesOf,
  turnIdsToOpen,
} from '@/lib/subagent';
import {
  expandMany,
  initialNavState,
  navReducer,
  type NavAction,
  type NavState,
} from '@/lib/tree-nav';
import { buildThread, type SessionViewMode } from '@/lib/thread';
import { DriftBanner } from '@/components/session/DriftBanner';
import { EventDetail } from '@/components/session/EventDetail';
import { FollowPill } from '@/components/session/FollowPill';
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
  /** The app-wide frame bus. Absent means this screen does not tail. */
  bus?: LiveBus;
  /**
   * The event `seq` a search hit named. Absent means an ordinary open.
   *
   * A `seq` rather than a row index, because a `seq` survives a reprojection and
   * a row index does not.
   */
  revealSeq?: number;
}

export function SessionView({ sessionId, api, bus, revealSeq }: SessionViewProps) {
  const client = useMemo(() => api ?? createApiClient(), [api]);

  /*
   * One clock reading, taken once, for the one surface that needs one: a live
   * session's header has no `ended_at` to close its elapsed time against. The
   * tree below reads no clock at all — an event carries the duration the
   * projector measured.
   */
  const [now] = useState(() => Date.now());

  /*
   * The refetch-from-zero seam, and it is `use-async.ts:19-21`'s own: the
   * effect is keyed `[key, refreshToken]` precisely so this task could ask the
   * SAME session to load again. Bumped by one frame kind only — an epoch that
   * moved backwards, which is a file the page in hand cannot be spliced onto.
   */
  const [refresh, setRefresh] = useState(0);
  const state = useAsync<SessionData>(
    sessionId,
    (signal) => loadSessionDetail(client, sessionId, { signal }),
    refresh,
  );
  const loaded = state.kind === 'ok' ? state.value : null;

  /*
   * The spliced page, held beside the loaded one and consumed through
   * `overlayData` — never a bare `??`. Both of its identities are load-bearing;
   * `overlayData`'s own header says which reload each one closes.
   */
  const [overlay, setOverlay] = useState<Overlay<SessionData> | null>(null);
  const data = overlayData(overlay, sessionId, loaded);

  const [nav, setNav] = useState<NavState>(() => initialNavState());
  const dispatch = useCallback((action: NavAction) => {
    setNav((current) => navReducer(current, action));
  }, []);

  /** Which sidecars are loaded, in flight or failed. Every decision is in `subagent.ts`. */
  const [sub, dispatchSub] = useReducer(subagentReducer, initialSubagentState);

  /** Follow mode. Every rule of it is `followReducer`'s; this holds the state. */
  const [follow, dispatchFollow] = useReducer(followReducer, initialFollowState);

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
    // The sub-agent state would otherwise outlive the session it belongs to,
    // and `mergedRowIds` would then keep a previous session's selection alive.
    dispatchSub({ type: 'reset' });
    // Follow is on when a session opens, and a move between sessions is an
    // opening — otherwise the reader arrives paused with a backlog counted
    // against a session they never looked at.
    dispatchFollow({ type: 'reset' });
  }

  const model = useMemo(
    () => buildTurnGroups(data?.turns ?? [], data?.eventsByTurn ?? new Map()),
    [data],
  );
  const subtrees = useMemo(() => subtreesOf(sub), [sub]);
  /*
   * The session the ROWS belong to, read off the data in hand rather than off
   * the prop. They differ by one render after a move between sessions, and
   * stamping the incoming id onto the outgoing session's rows is the same
   * off-by-one `needsReseed` exists to close.
   */
  const rootSessionId = data?.session.id ?? sessionId;
  const rows = useMemo(
    () => flatten(model, nav.expandedIds, undefined, { rootSessionId, subtrees }),
    [model, nav.expandedIds, rootSessionId, subtrees],
  );

  /*
   * ★ THE JUMP FROM A SEARCH HIT, AS A ONE-SHOT LATCH.
   *
   * Seeded HERE and not beside `needsReseed` above, for two reasons. The seed
   * has to run after that block or the reseed would replace the navigation state
   * it just expanded; and this is where `rows` exists, which is what test 7 pins.
   *
   * ★ THE SEED SETS THE EXPANSION AND THE LATCH, AND NOTHING ELSE. Setting
   * `selectedId` here would consume the latch on the very next render, and the
   * tree would never receive an index to scroll to at all. `initialExpanded`
   * opens the last turn alone, so a hit's row is usually absent from `rows` on
   * arrival — `expandMany` is what makes it appear.
   */
  const revealed = revealTarget(data, revealSeq);
  const revealKey = revealed === null ? null : `${rootSessionId}|${String(revealSeq)}`;
  const [revealSeededFor, setRevealSeededFor] = useState<string | null>(null);
  const [revealLatch, setRevealLatch] = useState<RevealLatch | null>(null);
  if (revealed !== null && revealKey !== revealSeededFor) {
    setRevealSeededFor(revealKey);
    setNav((current) => expandMany(current, [revealed.turnId]));
    setRevealLatch(revealed);
  }

  /*
   * ★ CONSUMED ON DELIVERY, AND THE WRITE-BACK IS AN EFFECT ON PURPOSE.
   *
   * `revealStep` is pure and its rule is one-shot: it keeps the latch while the
   * row is absent and drops it the render the row appears, answering the index,
   * the selection and the focus together.
   *
   * The write-back cannot be a render-phase update. React re-runs a component
   * that sets its own state during render and DISCARDS that pass without
   * rendering children — so clearing the latch during render would throw away
   * the one render in which `SpanTree` is handed an index, and the scroll would
   * never fire. Clearing it after the commit is what lets the delivery render
   * reach the tree. The guard is still the guard: writing back unconditionally
   * would loop forever.
   */
  const { latch: nextLatch, revealIndex, selectedId, focusedIndex } = revealStep(revealLatch, rows);
  useEffect(() => {
    if (nextLatch === revealLatch) return;
    setRevealLatch(nextLatch);
    if (selectedId === undefined || focusedIndex === undefined) return;
    // Selection and focus in ONE update, the shape the pointer path already
    // uses below: a row that is selected but not focused is a row the keyboard
    // would then move away from.
    setNav((current) => ({ ...current, focusedIndex, selectedId }));
  }, [nextLatch, revealLatch, selectedId, focusedIndex]);

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
    dispatch(rowsChangedAction(model, rows, sub));
  }, [dispatch, model, rows, sub]);

  /*
   * ONE SUBSCRIPTION, AND EVERY DECISION IN IT BELONGS TO `@/lib/live`.
   *
   * `decideFrame` answers ignore / refetch / splice; `applyFrame` produces the
   * spliced page. What is left here is a fetch and two setters — which is all a
   * module no test in this project can reach should be trusted with.
   *
   * The current page is read through a ref rather than through the dependency
   * array: re-subscribing on every splice would drop frames in the window
   * between the two, and the ref is the same instrument `use-async.ts` uses on
   * its loader.
   */
  const liveRef = useRef<{ data: SessionData | null; base: SessionData | null }>({
    data: null,
    base: null,
  });
  liveRef.current = { data, base: loaded };

  useEffect(() => {
    if (bus === undefined) return;
    return bus.subscribe((frame) => {
      if (frame.event !== 'session_changed') return;
      const { data: current, base } = liveRef.current;
      const decision = decideFrame(current, frame.data);
      if (decision.kind === 'ignore') return;
      if (decision.kind === 'refetch') {
        // AND NOTHING ELSE. The overlay is not cleared: `overlayData` retires it
        // by identity the instant the reload lands, and clearing it here would
        // blank the tree for the length of the request instead.
        setRefresh((token) => token + 1);
        return;
      }
      if (current === null || base === null) return;
      void client
        .getSession(sessionId, { from_seq: decision.from_seq, limit: EVENT_LIMIT })
        .then((body) => {
          const next = applyFrame(current, frame.data, body);
          setOverlay({ key: sessionId, base, data: next });
          dispatchFollow({ type: 'appended', count: next.events.length - current.events.length });
        })
        .catch(() => undefined);
    });
  }, [bus, client, sessionId]);

  /*
   * ONE ABORT CONTROLLER PER SESSION, HELD IN A REF.
   *
   * Its cleanup is the only abort in this file, and that is the whole point. The
   * obvious spelling puts the controller in the fetch effect and `sub` in its
   * dependencies — and then the `requested` dispatch below re-renders, React
   * runs the previous cleanup, the request it just issued is aborted, and the
   * re-run asks for nothing because the id is now pending. The child never
   * loads, and no test in this repo can see it: effects do not fire under
   * `environment: 'node'`. `use-async.ts` holds its loader in a ref and keys on
   * a string for exactly this reason; this follows it.
   */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, [sessionId]);

  /*
   * The child ids this expansion demands, as ONE STABLE STRING.
   *
   * `childIdsToFetch` already excludes what is loaded, in flight or failed and
   * returns what is left in row order, so this key changes only when a new
   * sub-agent is actually opened.
   */
  const wantedKey = childIdsToFetch(rows, nav.expandedIds, sub).join(',');

  useEffect(() => {
    if (wantedKey === '') return;
    const signal = abortRef.current?.signal;
    for (const childId of wantedKey.split(',')) {
      dispatchSub({ type: 'requested', childId });
      loadSessionDetail(client, childId, {
        limit: EVENT_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      })
        .then((child) => {
          dispatchSub({ type: 'loaded', childId, child });
          // Its own turns have to open, or the sidecar draws a header and no
          // events: `flatten` descends into a turn only when its id is in the
          // expansion set, and a fresh child's ids cannot be in one seeded from
          // the parent's turns.
          setNav((current) => expandMany(current, turnIdsToOpen(child)));
        })
        .catch(() => {
          // An abort is this component going away, not a failure to record.
          if (signal?.aborted !== true) dispatchSub({ type: 'failed', childId });
        });
    }
    // NEVER `sub` and NEVER `rows`: both change as a direct result of what this
    // effect does, and either one here reinstates the self-cancelling defect.
  }, [wantedKey, client]);

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
      // Reading beats following (`04-live-tail.md:18`): a selection pauses the
      // tail, and the pill starts counting what arrives meanwhile.
      dispatchFollow({ type: 'selected' });
      setNav((current) => {
        const index = rows.findIndex((row) => row.id === id);
        return index === -1 ? current : { ...current, focusedIndex: index, selectedId: id };
      });
    },
    [rows],
  );

  const onScrollMetrics = useCallback((metrics: ScrollMetrics) => {
    dispatchFollow({ type: 'scrolled', atBottom: atBottom(metrics) });
  }, []);

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
      {data === null ? null : (
        <DriftBanner
          hasDrift={data.session.has_drift}
          harnessVersion={data.session.harness_version}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {view === 'thread' && data !== null ? (
          <ThreadView rows={thread} startedAt={data.session.started_at} />
        ) : (
          <>
            {/*
             * `followIndex` reaches the tree ONLY while following, which closes
             * the resume direction structurally: a programmatic scroll can then
             * land only in a state where "scrolled to the end" is already a
             * no-op for the reducer. The pill sits over the pane rather than
             * inside the scroller, so it holds still while rows move under it.
             */}
            <div data-slot="tree-pane" className="relative min-w-0 flex-1 border-r border-border">
              <SpanTree
                rows={rows}
                selectedId={nav.selectedId}
                focusedIndex={nav.focusedIndex}
                followIndex={follow.following && rows.length > 0 ? rows.length - 1 : undefined}
                revealIndex={revealIndex}
                onScrollMetrics={onScrollMetrics}
                onKeyDown={onKeyDown}
                onSelect={onSelect}
                onToggle={onToggle}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                <div className="pointer-events-auto">
                  <FollowPill
                    label={pillLabel(follow)}
                    onResume={() => dispatchFollow({ type: 'resumed' })}
                  />
                </div>
              </div>
            </div>

            <EventDetail event={selectedEvent} fetched={fetched} onShowFull={onShowFull} />
          </>
        )}
      </div>
    </main>
  );
}
