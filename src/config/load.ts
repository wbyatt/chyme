import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, NotFoundError } from '../util/errors.js';
import { resolveConfigPath } from './paths.js';
import {
  configSchema,
  defaultConfig,
  type ChymeConfig,
  type ProjectConfig,
} from './schema.js';

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface LoadedConfig {
  config: ChymeConfig;
  path: string;
  /** False when no config file exists yet; `config` is then the empty default. */
  exists: boolean;
}

/**
 * Replace `${VAR}` in credential strings with the environment's value.
 *
 * A missing variable is a hard error rather than an empty substitution: an
 * empty token produces a 401 several layers away from the cause, which is a
 * miserable thing to debug.
 */
function interpolate(value: unknown, path: string[], missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (match, name: string) => {
      const found = process.env[name];
      if (found === undefined || found === '') {
        missing.add(name);
        return match;
      }
      return found;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(item, [...path, String(index)], missing));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, [...path, key], missing)]),
    );
  }
  return value;
}

/**
 * Resolve one driver's credentials, interpolating `${ENV_VAR}` as late as
 * possible.
 *
 * Lateness is the point. Only the sync path needs a token; activity, thread,
 * search and digest read the local store and must keep working with no
 * credentials configured at all — including on a machine that never had them.
 * Interpolating at load time made every read command fail without a token.
 */
export function credentialsFor(
  config: ChymeConfig,
  driverId: string,
): Record<string, unknown> | undefined {
  const raw = config.credentials[driverId];
  if (raw === undefined) return undefined;

  const missing = new Set<string>();
  const resolved = interpolate(raw, ['credentials', driverId], missing) as Record<string, unknown>;

  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new ConfigError(
      `credentials.${driverId} references unset environment ${
        names.length === 1 ? 'variable' : 'variables'
      }: ${names.join(', ')}`,
      `Export ${names.length === 1 ? 'it' : 'them'}, or replace the \${...} placeholder in the config with a literal value.`,
    );
  }

  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = resolveConfigPath(env);

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: defaultConfig(), path, exists: false };
    }
    throw new ConfigError(
      `Could not read config at ${path}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Config at ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Config at ${path} is invalid:\n${issues}`);
  }

  const slugs = new Set<string>();
  for (const project of result.data.projects) {
    if (slugs.has(project.slug)) {
      throw new ConfigError(`Config defines project "${project.slug}" more than once.`);
    }
    slugs.add(project.slug);

    const keys = new Set<string>();
    for (const source of project.sources) {
      const composite = `${source.driver}:${source.key}`;
      if (keys.has(composite)) {
        throw new ConfigError(
          `Project "${project.slug}" lists source ${composite} more than once.`,
        );
      }
      keys.add(composite);
    }
  }

  return { config: result.data, path, exists: true };
}

/**
 * Write the config atomically and readable only by its owner — it may contain
 * an API token.
 *
 * Three things here are deliberate, and each was wrong in an earlier version:
 *
 * - The temp file is *created* with mode 0600 via an exclusive open. Passing
 *   `mode` to `writeFileSync` only applies when the file is created, so writing
 *   over an existing temp file left it at whatever mode it already had — and
 *   `writeFileSync` follows symlinks, so a planted link could have carried the
 *   token somewhere else entirely. `wx` refuses to open anything that exists.
 * - The suffix is random rather than the pid, because pids recycle and the
 *   predictable name is the thing that made a stale file reusable.
 * - The temp file is removed if the rename fails, so a token never stays behind
 *   in a file nothing will clean up.
 */
export function saveConfig(config: ChymeConfig, path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporary = join(directory, `.config.${randomBytes(8).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(config, null, 2)}\n`;

  let handle: number;
  try {
    handle = openSync(temporary, 'wx', 0o600);
  } catch (error) {
    throw new ConfigError(
      `Could not create a temporary file next to ${path}: ${(error as Error).message}`,
    );
  }

  try {
    writeFileSync(handle, payload);
    // Durable before the rename: otherwise a crash can leave the config
    // replaced by a zero-length file, and the token with it.
    fsyncSync(handle);
  } catch (error) {
    closeSync(handle);
    removeQuietly(temporary);
    throw new ConfigError(`Could not write ${path}: ${(error as Error).message}`);
  }
  closeSync(handle);

  try {
    renameSync(temporary, path);
  } catch (error) {
    removeQuietly(temporary);
    throw new ConfigError(`Could not replace ${path}: ${(error as Error).message}`);
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort. The write already failed; a cleanup failure on top of it has
    // nothing useful to add to the error the caller is about to see.
  }
}

export function findProject(config: ChymeConfig, slug: string): ProjectConfig {
  const project = config.projects.find((candidate) => candidate.slug === slug);
  if (!project) {
    const known = config.projects.map((candidate) => candidate.slug);
    throw new NotFoundError(
      `No project "${slug}" in the config.`,
      known.length > 0
        ? `Known projects: ${known.join(', ')}`
        : 'Add one with: chyme project add <slug> --name "<name>"',
    );
  }
  return project;
}

class AmbiguousProjectError extends ConfigError {
  constructor(slugs: string[]) {
    super(
      'Multiple projects are configured; say which one you mean.',
      `Pass --project with one of: ${slugs.join(', ')}`,
    );
  }
}

/**
 * The project to act on when the user did not name one. Unambiguous only when
 * exactly one project is configured; otherwise the caller must ask.
 */
export function defaultProject(config: ChymeConfig): ProjectConfig {
  if (config.projects.length === 1) return config.projects[0]!;
  if (config.projects.length === 0) {
    throw new NotFoundError(
      'No projects are configured.',
      'Add one with: chyme project add <slug> --name "<name>"',
    );
  }
  throw new AmbiguousProjectError(config.projects.map((project) => project.slug));
}
