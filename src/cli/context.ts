import { defaultProject, findProject } from '../config/load.js';
import { resolveDataDir, resolveDatabasePath } from '../config/paths.js';
import type { ChymeConfig, ProjectConfig } from '../config/schema.js';
import { createDriverFromConfig } from '../drivers/registry.js';
import type { ForgeDriver } from '../drivers/types.js';
import { openStore, type Store } from '../store/index.js';
import type { DriverResolver } from '../sync/sync.js';

/** Where this config's database lives, honouring `dataDir` and the env overrides. */
export function databasePathFor(config: ChymeConfig): string {
  return resolveDatabasePath(resolveDataDir(config.dataDir));
}

export function openStoreFor(config: ChymeConfig): Store {
  return openStore(databasePathFor(config));
}

/**
 * Memoized per run so several sources on the same forge share one client — and
 * therefore one rate-limit budget and one set of retry state. Building a driver
 * per source would multiply the request budget by the number of repositories,
 * which is precisely backwards.
 */
export function driverResolver(config: ChymeConfig): DriverResolver {
  const built = new Map<string, ForgeDriver>();
  return (id: string): ForgeDriver => {
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
