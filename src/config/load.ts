import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function interpolateCredentials(config: ChymeConfig): ChymeConfig {
  const missing = new Set<string>();
  const credentials = interpolate(config.credentials, ['credentials'], missing) as ChymeConfig['credentials'];

  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new ConfigError(
      `Config references unset environment ${names.length === 1 ? 'variable' : 'variables'}: ${names.join(', ')}`,
      `Export ${names.length === 1 ? 'it' : 'them'}, or replace the \${...} placeholder in the config with a literal value.`,
    );
  }

  return { ...config, credentials };
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

  return { config: interpolateCredentials(result.data), path, exists: true };
}

/**
 * Write the config atomically and readable only by its owner — it may contain
 * an API token.
 */
export function saveConfig(config: ChymeConfig, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.config.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
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
