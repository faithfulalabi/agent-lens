// Host-header allowlist (RFC decision 6): the collector binds loopback only, but
// a DNS-rebinding page could still POST with a foreign Host. Reject anything
// whose Host hostname isn't a loopback name. Runs app-wide, before token auth.

import type { MiddlewareHandler } from 'hono';

const ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

/** Strip an optional `:port` suffix, leaving the bare hostname. */
function hostnameOf(host: string): string {
  // Bracketed IPv6 literal: `[::1]:4470` -> `[::1]`.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** 403 unless the request's Host hostname is a loopback name. */
export function hostGuard(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (host === undefined || !ALLOWED_HOSTNAMES.has(hostnameOf(host))) {
      return c.text('Forbidden', 403);
    }
    return next();
  };
}
