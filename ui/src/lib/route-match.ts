/*
 * The route table (Task 5.1c, AC3): two total functions over strings, and
 * nothing else.
 *
 * This module is deliberately alone in its file. Its test asserts purity by
 * scanning the WHOLE source, which is only a meaningful assertion when the file
 * has exactly one concern — a scan over "part of a file" has no defensible
 * boundary. Everything that reads or writes the address bar lives next door in
 * `router.ts`, which is scanned for the opposite property.
 *
 * That scan reads raw source, comments included (the same instrument, and the
 * same trap, as `components/__tests__/retokenized.test.ts`), so this header
 * names the forbidden identifiers by role rather than spelling them: callers
 * hand `matchRoute` the current path as a string, and `hrefFor` inverts it.
 * Neither function reads ambient state, a clock or a random source, and there
 * is no module-level mutable binding for one to hide in.
 *
 * Both functions are total. A path that matches nothing is `not_found` rather
 * than a throw, and an id whose percent-encoding is malformed is returned raw
 * rather than blowing up the render.
 */

/** Every route in the locked URL scheme, plus the miss. */
export type Route =
  | { name: 'sessions' }
  | { name: 'session'; sessionId: string }
  | { name: 'trace'; sessionId: string; turnSeq: number }
  | { name: 'showcase' }
  /** Carries the path so a 404 view can show what was asked for. */
  | { name: 'not_found'; path: string };

/**
 * A turn sequence is digits and nothing else — the same convention as the read
 * API's page params, and `0` is a legitimate value.
 */
const NON_NEGATIVE_INT = /^\d+$/;

/**
 * Resolve a path to a route.
 *
 * Query and fragment are ignored and one trailing slash is normalised away, so
 * Task 7.2 can put query-string state there without touching this table.
 */
export function matchRoute(pathname: string): Route {
  const path = normalize(pathname);
  if (path === '/') return { name: 'sessions' };
  if (path === '/showcase') return { name: 'showcase' };

  const segments = path.slice(1).split('/');
  if (segments[0] === 'session') {
    const sessionId = decode(segments[1]);
    if (sessionId !== undefined && sessionId !== '') {
      if (segments.length === 2) return { name: 'session', sessionId };
      if (
        segments.length === 4 &&
        segments[2] === 'trace' &&
        NON_NEGATIVE_INT.test(segments[3] ?? '')
      ) {
        return { name: 'trace', sessionId, turnSeq: Number(segments[3]) };
      }
    }
  }
  return { name: 'not_found', path: pathname };
}

/**
 * The inverse: the href a route is reachable at.
 *
 * Ids are percent-encoded, which is what keeps a slash-bearing or unicode id
 * from splitting into extra segments on the way back through `matchRoute`.
 */
export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'sessions':
      return '/';
    case 'showcase':
      return '/showcase';
    case 'session':
      return `/session/${encodeURIComponent(route.sessionId)}`;
    case 'trace':
      return `/session/${encodeURIComponent(route.sessionId)}/trace/${route.turnSeq}`;
    case 'not_found':
      return route.path;
  }
}

/** Leading slash guaranteed, query/fragment dropped, one trailing slash cut. */
function normalize(pathname: string): string {
  const bare = pathname.split('?')[0]?.split('#')[0] ?? '';
  const rooted = bare.startsWith('/') ? bare : `/${bare}`;
  return rooted.length > 1 && rooted.endsWith('/') ? rooted.slice(0, -1) : rooted;
}

/** Percent-decoded, or the raw segment when the encoding is malformed. */
function decode(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
