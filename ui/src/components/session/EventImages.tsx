import type { EventRow } from '@/lib/api';
import { type FetchedImages, imageViewsOf } from '@/lib/event-content';

/**
 * An event's images, drawn from same-origin object URLs. An `<img>` is mounted only once its
 * bytes are in hand, so a refused fetch reads as a sentence and never as a broken-image glyph.
 */
export function EventImages({ event, images }: { event: EventRow; images: FetchedImages | null }) {
  const views = imageViewsOf(event, images);
  if (views.length === 0) return null;

  return (
    <section data-slot="event-images" className="flex flex-col gap-2 pt-2">
      {views.map((view, n) => (
        <figure key={n} data-slot="event-image">
          {view.url === null ? null : (
            <a href={view.url} target="_blank" rel="noreferrer">
              <img
                src={view.url}
                alt={`image ${n + 1} of ${views.length}`}
                className="max-h-96 max-w-full rounded-md border border-border object-contain"
              />
            </a>
          )}
          {view.note === null ? null : (
            <figcaption data-slot="event-image-note" className="text-2xs text-faint">
              {view.note}
            </figcaption>
          )}
        </figure>
      ))}
    </section>
  );
}
