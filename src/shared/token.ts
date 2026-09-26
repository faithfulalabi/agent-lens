// Local auth token helper (RFC security baseline): a random token at
// `~/.agent-lens/token` with 0600 perms, sent as the `x-agentlens-token`
// header. The collector accepts only loopback connections; the token guards
// against other local users. `AGENT_LENS_DIR` overrides the directory for
// hermetic tests. Task 1.2 owns read/write/regenerate; 1.3/1.4/2.5 consume it.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** HTTP header the token travels in. */
export const TOKEN_HEADER = 'x-agentlens-token';

const TOKEN_FILE = 'token';

/** Resolve the agent-lens data dir: explicit arg -> $AGENT_LENS_DIR -> ~/.agent-lens. */
function resolveDir(dir?: string): string {
  return dir ?? process.env.AGENT_LENS_DIR ?? join(homedir(), '.agent-lens');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Read the token if it exists, else `null`. Never creates anything. */
export function readToken(dir?: string): string | null {
  const tokenPath = join(resolveDir(dir), TOKEN_FILE);
  try {
    return readFileSync(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Return the existing token, or generate + persist a new one (0600) when
 * missing. The write is atomic: a temp sibling created with mode 0600 is
 * renamed into place, so readers never observe a partial file.
 */
export function readOrCreateToken(dir?: string): string {
  const existing = readToken(dir);
  if (existing !== null) {
    return existing;
  }

  const targetDir = resolveDir(dir);
  mkdirSync(targetDir, { recursive: true });

  const token = generateToken();
  const tokenPath = join(targetDir, TOKEN_FILE);
  const tempPath = join(targetDir, `${TOKEN_FILE}.tmp.${process.pid}`);

  writeFileSync(tempPath, token, { mode: 0o600 });
  // Defensive: umask can mask the create-mode above.
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, tokenPath);

  return token;
}
