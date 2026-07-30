import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Chyme keeps config and data outside the project directory, in XDG locations.
 * That is partly convention and partly safety: the config file can hold an API
 * token, and a token that lives in a working tree eventually gets committed.
 */

export function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

/** `$CHYME_CONFIG`, else `$XDG_CONFIG_HOME/chyme/config.json`, else `~/.config/chyme/config.json`. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CHYME_CONFIG?.trim();
  if (explicit) return expandTilde(explicit);

  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? expandTilde(xdg) : join(homedir(), '.config');
  return join(base, 'chyme', 'config.json');
}

/**
 * `dataDir` from config, else `$CHYME_DATA_DIR`, else `$XDG_DATA_HOME/chyme`,
 * else `~/.local/share/chyme`. Relative paths in config are resolved against
 * the home directory rather than the cwd, so behaviour does not depend on where
 * the CLI was invoked from.
 */
export function resolveDataDir(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (configured?.trim()) {
    const expanded = expandTilde(configured.trim());
    return isAbsolute(expanded) ? expanded : join(homedir(), expanded);
  }

  const explicit = env.CHYME_DATA_DIR?.trim();
  if (explicit) return expandTilde(explicit);

  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg ? expandTilde(xdg) : join(homedir(), '.local', 'share');
  return join(base, 'chyme');
}

export function resolveDatabasePath(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.CHYME_DB?.trim();
  if (explicit) return expandTilde(explicit);
  return join(dataDir, 'chyme.db');
}
