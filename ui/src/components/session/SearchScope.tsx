import { scopeLine, warmLabel, type WarmState } from '@/lib/search';

/*
 * What the screen just searched, and what it did not (Task 7.2), props-in.
 *
 * ===========================================================================
 * THIS COMPONENT IS THE HONESTY REQUIREMENT.
 * ===========================================================================
 * `/api/search` without `?session=` covers only PROJECTED transcripts and
 * reports the residual as `unprojected_count`. A screen that searched part of
 * the corpus silently is worse than one that admits it, because the reader
 * takes "no matches" for "it never happened". So the scope is stated on every
 * query, and the residual is stated beside a control that closes it.
 *
 * The sentence lives in `@/lib/search` beside the rest of the copy, on
 * `driftNotice`'s rule: copy in a pure function is copy a test can pin. It never
 * says "sessions" for the projected scope — measured, 272 of 293 rows are
 * sub-agent transcripts the session list never shows.
 *
 * ===========================================================================
 * NOTHING TO SAY MEANS NOTHING ON SCREEN.
 * ===========================================================================
 * No query yet draws no strip at all, on `DriftBanner`'s rule. The warm control
 * obeys the same rule one level down: a corpus with nothing left to warm shows
 * no control, so a control stuck permanently on is falsifiable.
 */

export interface SearchScopeProps {
  /** `null` before the first answer — the screen has searched nothing yet. */
  scope?: 'projected' | 'session' | null;
  unprojectedCount: number;
  /** How far a started warm run has got, or `null` if none was started. */
  warm?: WarmState | null;
  onWarm?: () => void;
}

export function SearchScope({ scope, unprojectedCount, warm = null, onWarm }: SearchScopeProps) {
  if (scope === undefined || scope === null) return null;

  return (
    <div
      data-slot="search-scope"
      role="status"
      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted"
    >
      <span className="min-w-0">{scopeLine(scope)}</span>
      {unprojectedCount > 0 ? (
        <button
          type="button"
          data-slot="search-warm"
          onClick={onWarm}
          className="ml-auto shrink-0 rounded-md bg-surface px-2 py-0.5 uppercase tracking-widest transition-colors hover:text-foreground"
        >
          {warmLabel(unprojectedCount, warm)}
        </button>
      ) : null}
    </div>
  );
}
