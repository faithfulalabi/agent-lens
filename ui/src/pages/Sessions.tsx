import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { createApiClient, type ApiClient } from '@/lib/api';
import { overlayData, patchListRow, type LiveBus, type Overlay } from '@/lib/live';
import type { Router } from '@/lib/router';
import { defaultRouter } from '@/lib/use-route';
import { useAsync } from '@/lib/use-async';
import {
  applyIntent,
  cursorIntent,
  emptyStateOf,
  loadSessionList,
  projectsIn,
  selectRows,
  volumeBuckets,
  type SessionListData,
  type SortColumn,
  type SortDirection,
  type TimeRange,
} from '@/lib/session-list';
import { EmptyState } from '@/components/session/EmptyState';
import { RangeControl } from '@/components/session/RangeControl';
import { SessionListView } from '@/components/session/SessionListView';
import { VolumeHistogram } from '@/components/session/VolumeHistogram';

/*
 * The session list's page module (Task 5.2b) — the screen at `/`.
 *
 * ===========================================================================
 * BOTH PORTS ARE PROPS. THIS IS NOT STYLE; IT IS THE ONLY TESTABLE SHAPE.
 * ===========================================================================
 * `createApiClient()`'s default reads the page bootstrap, and that read THROWS
 * outside a browser. A `useMemo` does not save you: it runs during render, not
 * at module load, so "lazy" defers the throw by exactly nothing. Without an
 * injectable `api` this page could have no render test at all — and Task
 * 5.3's `<App />` render at `/session/x` reaches this same line. The memo below
 * therefore builds a client only when the caller supplied none.
 *
 * The router is a prop for the same reason and an older one: Task 5.1c shipped
 * `HistoryPort` saying in as many words that 5.2 and 5.3 would render pages
 * against a fake port. That is what turns "enter opens the row" into an
 * assertion instead of a caveat.
 *
 * Every decision this screen makes lives in `@/lib/session-list` as a plain
 * function. What is left here is state and wiring, which is all a component in
 * a DOM-less test environment can honestly be trusted with.
 *
 * ===========================================================================
 * THE LOAD KEY CARRIES THE PROJECT, AND THAT IS DELIBERATE.
 * ===========================================================================
 * Narrowing by project is a client-side pass over the loaded page — except in
 * the one state where that pass would state a falsehood, which is a truncated
 * page holding no row of the wanted project. `loadSessionList` resolves that by
 * asking the server, so it has to KNOW the project, so the project has to be
 * part of what invalidates the load. The alternative — a second async slot
 * beside this one — buys a saved round trip against localhost SQLite at the
 * price of two states that can disagree with each other.
 */

const BUCKET_COUNT = 40;

export interface SessionsProps {
  router?: Router;
  api?: ApiClient;
  /** The app-wide frame bus. Absent means this screen does not tail. */
  bus?: LiveBus;
}

export function Sessions({ router = defaultRouter(), api, bus }: SessionsProps = {}) {
  const [range, setRange] = useState<TimeRange>('3d');
  const [project, setProject] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<SortColumn>('last_activity_at');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [cursor, setCursor] = useState(-1);

  const client = useMemo(() => api ?? createApiClient(), [api]);

  /*
   * One clock reading for the whole screen, taken once.
   *
   * Reading `Date.now()` during render would let two rows disagree about when
   * "now" is, and would move the range bounds under an in-flight request. Live
   * elapsed times therefore hold still until something reloads; a live frame
   * patches the row it names, in place, and reads its own clock to do it.
   */
  const [now] = useState(() => Date.now());

  const listKey = `${range}|${project ?? ''}`;
  const state = useAsync(listKey, (signal) =>
    loadSessionList(client, { range, now, project, signal }),
  );

  const loaded = state.kind === 'ok' ? state.value : null;

  /*
   * The patched page, held beside the loaded one and consumed through
   * `overlayData` — KEYED, never a bare `??`.
   *
   * Changing the range or the project is this screen's primary gesture and it
   * changes the load key. An unkeyed overlay would pin the whole screen to the
   * snapshot the first frame landed on, because `volumeBuckets`, `projectsIn`,
   * `emptyStateOf` and the rows all read this one value.
   */
  const [overlay, setOverlay] = useState<Overlay<SessionListData> | null>(null);
  const data = overlayData(overlay, listKey, loaded);

  /*
   * ONE SUBSCRIPTION, AND NO SECOND REQUEST — EVER.
   *
   * `patchListRow` takes no `ApiClient`, so a fetch is unrepresentable inside
   * it, and the frame carries every rollup the row needs. An id this page never
   * loaded returns the SAME object: inserting a row would make `truncated`,
   * `outsideRangeCount` and the project narrowing describe a page the server
   * never served.
   */
  const listRef = useRef<{ data: SessionListData | null; base: SessionListData | null }>({
    data: null,
    base: null,
  });
  listRef.current = { data, base: loaded };

  useEffect(() => {
    if (bus === undefined) return;
    return bus.subscribe((frame) => {
      if (frame.event !== 'session_changed') return;
      const { data: current, base } = listRef.current;
      if (current === null || base === null) return;
      const next = patchListRow(current, frame.data.session_id, frame.data.rollups, Date.now());
      if (next === current) return;
      setOverlay({ key: listKey, base, data: next });
    });
  }, [bus, listKey]);
  const rows = useMemo(
    () => (data === null ? [] : selectRows(data, { project, sort, direction })),
    [data, project, sort, direction],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
      const inEditable =
        target?.isContentEditable === true ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');

      const intent = cursorIntent(event.key, { index: cursor, rowCount: rows.length, inEditable });
      if (intent.kind === 'ignore') return;
      event.preventDefault();
      const next = applyIntent(intent, rows, router);
      if (next !== null) setCursor(next);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cursor, rows, router]);

  const empty = data === null ? null : emptyStateOf(data, rows, { project });

  /*
   * The histogram and the controls stay mounted across a reload, and only the
   * table body swaps.
   *
   * Changing the range is this screen's primary gesture, and it changes the
   * load key — so an early return on the pending state would unmount the very
   * control that was just clicked, losing its focus and flashing the whole page
   * blank each time. `volumeBuckets` draws a flat baseline from no sessions
   * precisely so there is something honest to hold the space meanwhile.
   */
  return (
    <Pane>
      <VolumeHistogram
        buckets={volumeBuckets(data?.sessions ?? [], { range, now, bucketCount: BUCKET_COUNT })}
      />
      <RangeControl
        range={range}
        onRangeChange={setRange}
        projects={data === null ? [] : projectsIn(data.sessions)}
        project={project}
        onProjectChange={setProject}
      />
      {state.kind === 'error' ? (
        <p className="text-sm text-error">{state.error.message}</p>
      ) : empty === null ? null : empty.kind === 'none' ? (
        <SessionListView
          rows={rows}
          sort={sort}
          direction={direction}
          onSortChange={(column) => {
            setDirection(column === sort && direction === 'desc' ? 'asc' : 'desc');
            setSort(column);
          }}
          cursor={cursor}
          now={now}
          pageTruncated={data?.truncated ?? false}
        />
      ) : (
        <EmptyState state={empty} />
      )}
    </Pane>
  );
}

function Pane({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex max-w-5xl flex-col gap-4 px-8 py-6">{children}</main>;
}
