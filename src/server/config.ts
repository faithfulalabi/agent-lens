// Runtime config file: the bound port (post auto-increment), pid, and start
// time, written to `<dataDir>/config.json` so the hook adapter (Task 1.4) can
// discover the actual port without re-probing. Atomic (temp + rename) and 0600.

import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The runtime config contract read by Task 1.4's hook adapter. */
export interface RuntimeConfig {
  port: number;
  pid: number;
  started_at: string;
}

const CONFIG_FILE = 'config.json';

/** Write the runtime config atomically (0600). Overwrites any stale file. */
export function writeConfig(dataDir: string, config: RuntimeConfig): void {
  const target = join(dataDir, CONFIG_FILE);
  const temp = join(dataDir, `${CONFIG_FILE}.tmp.${process.pid}`);
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Defensive: umask can mask the create-mode above.
  chmodSync(temp, 0o600);
  renameSync(temp, target);
}

/** Read the runtime config, or `null` if it does not exist. */
export function readConfig(dataDir: string): RuntimeConfig | null {
  try {
    return JSON.parse(
      readFileSync(join(dataDir, CONFIG_FILE), 'utf8'),
    ) as RuntimeConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** Best-effort removal of the config file on clean shutdown. */
export function clearConfig(dataDir: string): void {
  rmSync(join(dataDir, CONFIG_FILE), { force: true });
}
