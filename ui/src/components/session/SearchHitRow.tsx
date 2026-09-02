import type { SearchHitRow as SearchHit } from '@/lib/api';

import { hrefFor } from '@/lib/route-match';
import { splitSnippet } from '@/lib/search';

/*
 * One search hit (Task 7.2), props-in on `DriftBanner`'s shape.
 *
 * ===========================================================================
 * THE SNIPPET IS SPLIT INTO TEXT RUNS. IT IS NEVER INSERTED AS MARKUP.
 * ===========================================================================
 * `snippet(events_fts, …)` wraps each match in marker literals around whatever
 * the transcript held, and transcripts hold source code. MEASURED against the
 * dev cache (293 sessions, 30,286 events) with `q=script` and `limit=300`, after
 * stripping the two markers: 81 of 300 snippets carry a raw `<` and 67 carry a
 * literal opening script tag. `splitSnippet` reads the markers and returns runs
 * of TEXT; React escapes every one of them. The highlight is a real `<mark>`
 * element this component draws, not one the server sent.
 *
 * ===========================================================================
 * THE JUMP IS AN ANCHOR AT A REAL HREF, NOT A CLICK HANDLER.
 * ===========================================================================
 * `back-to-sessions` set the idiom (`SessionHeader.tsx:88-96`): a real link is
 * right on a middle-click, right in a fresh tab, and keyboard-reachable for
 * free. The target rides on the hit already — `session_id` and `seq` — so no
 * lookup happens here. `seq` and not a row index, because a `seq` survives a
 * reprojection.
 */

export interface SearchHitRowProps {
  hit: SearchHit;
}

export function SearchHitRow({ hit }: SearchHitRowProps) {
  const parts = splitSnippet(hit.snippet);

  return (
    <a
      href={hrefFor({ name: 'event', sessionId: hit.session_id, seq: hit.seq })}
      data-slot="search-hit"
      data-event-id={hit.event_id}
      className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-surface"
    >
      <span className="flex items-center gap-2 text-2xs uppercase tracking-widest text-muted">
        <span>{hit.kind}</span>
        {hit.name === null ? null : <span className="truncate">{hit.name}</span>}
        <span className="ml-auto font-mono">#{hit.seq}</span>
      </span>
      <span className="min-w-0 font-mono text-2xs leading-relaxed text-muted">
        {parts.map((part, index) =>
          part.matched ? (
            <mark key={index} className="bg-surface-raised text-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    </a>
  );
}
