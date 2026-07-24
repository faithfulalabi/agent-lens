// Token auth for `/api/*` (RFC security baseline): constant-time compare of the
// `x-agentlens-token` header to the on-disk token. Missing/mismatch → 401. Not
// applied to the static page (which bootstraps the token same-origin instead).

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { TOKEN_HEADER } from '../../shared/index.js';

/** Length-safe constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** 401 unless `x-agentlens-token` matches the server token exactly. */
export function tokenAuth(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header(TOKEN_HEADER);
    if (provided === undefined || !safeEqual(provided, expected)) {
      return c.text('Unauthorized', 401);
    }
    return next();
  };
}
