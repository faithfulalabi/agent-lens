// Host-header allowlist (RFC decision 6): the collector binds loopback only, but
// a DNS-rebinding page could still POST with a foreign Host. Reject anything
// whose Host hostname isn't a loopback name. Runs app-wide, before token auth.

import { networkInterfaces } from 'node:os';
import type { MiddlewareHandler } from 'hono';

const ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

/** A bind host that keeps the default loopback-only allowlist. */
function isLoopbackBind(host: string): boolean {
  return ALLOWED_HOSTNAMES.has(host);
}

/**
 * Resolve the extra Host names a non-loopback `--host` bind must admit so LAN
 * clients (which send `Host: <machine-ip>`, never the bind literal `0.0.0.0`)
 * can reach the server. Returns the machine's non-internal interface addresses;
 * IPv6 literals are bracketed to match `Host` header form. A loopback bind adds
 * nothing (the default allowlist already covers it).
 */
export function resolveBindHosts(host: string): string[] {
  if (isLoopbackBind(host)) {
    return [];
  }
  const hosts: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      hosts.push(addr.family === 'IPv6' ? `[${addr.address}]` : addr.address);
    }
  }
  return hosts;
}

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

/**
 * 403 unless the request's Host hostname is allowed. Loopback names are always
 * admitted; `extraHosts` widens the set for a non-loopback `--host` bind (the
 * machine's resolved interface host/IP(s)) so the exposed server is reachable.
 * The literal bind address (e.g. `0.0.0.0`) is never admitted, and an arbitrary
 * name like `evil.com` never enters the set — the rebinding defense holds.
 */
export function hostGuard(extraHosts: string[] = []): MiddlewareHandler {
  const allowed = new Set([...ALLOWED_HOSTNAMES, ...extraHosts]);
  return async (c, next) => {
    const host = c.req.header('host');
    if (host === undefined || !allowed.has(hostnameOf(host))) {
      return c.text('Forbidden', 403);
    }
    return next();
  };
}
