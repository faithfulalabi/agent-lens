import { useEffect, useState } from 'react';
import { HttpError, type ApiClient, type EventRow } from './api.js';
import type { FetchedImages, ImageOutcome } from './event-content.js';

/**
 * An event's images as object URLs, because the token is a header an `<img src>` cannot send.
 * Fetches only while `event` is non-null; revokes on change or unmount.
 */
export function useEventImages(
  client: ApiClient | undefined,
  event: EventRow | null,
): FetchedImages | null {
  const [images, setImages] = useState<FetchedImages | null>(null);
  const eventId = event !== null && event.image_count > 0 ? event.id : null;
  const imageCount = event?.image_count ?? 0;
  useEffect(() => {
    if (client === undefined || eventId === null) return undefined;
    const controller = new AbortController();
    const urls: string[] = [];
    const fetchOne = (n: number): Promise<ImageOutcome> =>
      client.getEventImage(eventId, n, { signal: controller.signal }).then(
        (blob) => {
          // A blob that lands after cleanup must not mint a URL nothing will revoke.
          if (controller.signal.aborted) return { status: null };
          const url = URL.createObjectURL(blob);
          urls.push(url);
          return { url };
        },
        (error: unknown) => ({ status: error instanceof HttpError ? error.status : null }),
      );
    void Promise.all(Array.from({ length: imageCount }, (_, n) => fetchOne(n))).then((outcomes) => {
      if (!controller.signal.aborted) setImages({ eventId, outcomes });
    });
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      // Its URLs are dead now, and refetching this event must not draw them.
      setImages((current) => (current?.eventId === eventId ? null : current));
    };
  }, [client, eventId, imageCount]);
  return images;
}
