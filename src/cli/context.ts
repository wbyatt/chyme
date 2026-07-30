import { defaultProject, findProject } from '../config/load.js';
import { resolveDataDir, resolveDatabasePath } from '../config/paths.js';
import type { ChymeConfig, ProjectConfig } from '../config/schema.js';
import { createDriverFromConfig } from '../drivers/registry.js';
import type { SourceDriver } from '../drivers/types.js';
import { openStore, type ProjectRow, type Store } from '../store/index.js';
import type { DriverResolver } from '../sync/sync.js';
import { NotFoundError } from '../util/errors.js';

/** Where this config's database lives, honouring `dataDir` and the env overrides. */
export function databasePathFor(config: ChymeConfig): string {
  return resolveDatabasePath(resolveDataDir(config.dataDir));
}

export function openStoreFor(config: ChymeConfig): Store {
  return openStore(databasePathFor(config));
}

/**
 * Memoized per run so several sources served by the same driver share one client — and
 * therefore one rate-limit budget and one set of retry state. Building a driver
 * per source would multiply the request budget by the number of repositories,
 * which is precisely backwards.
 */
export function driverResolver(config: ChymeConfig): DriverResolver {
  const built = new Map<string, SourceDriver>();
  return (id: string): SourceDriver => {
    const existing = built.get(id);
    if (existing) return existing;
    const driver = createDriverFromConfig(id, config);
    built.set(id, driver);
    return driver;
  };
}

/** The project a command should act on: the named one, or the only one. */
export function selectProject(config: ChymeConfig, slug: string | undefined): ProjectConfig {
  return slug ? findProject(config, slug) : defaultProject(config);
}

/**
 * The stored counterpart of a configured project. A project can be configured
 * and never synced, and the read commands have nothing to say about it until it
 * has been — which is a different problem from a typo in the slug, so it gets a
 * different message.
 */
export function requireSyncedProject(store: Store, project: ProjectConfig): ProjectRow {
  const stored = store.projects.findProject(project.slug);
  if (!stored) {
    throw new NotFoundError(
      `"${project.slug}" has not been synced yet.`,
      `Run: chyme sync --project ${project.slug}`,
    );
  }
  return stored;
}
