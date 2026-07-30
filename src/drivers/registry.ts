import { ConfigError } from '../util/errors.js';
import type { ChymeConfig } from '../config/schema.js';
import { githubDriverFactory } from './github/index.js';
import type { DriverFactory, ForgeDriver } from './types.js';

/**
 * The one place that knows which forges exist.
 *
 * A driver id in the config is a promise that something can service it, and
 * this is where that promise is kept or refused. Adding a forge is one entry
 * here plus a directory; nothing else in Chyme changes.
 */

const FACTORIES: readonly DriverFactory[] = [githubDriverFactory];

const BY_ID: ReadonlyMap<string, DriverFactory> = new Map(
  FACTORIES.map((factory) => [factory.id, factory]),
);

/** Sorted, because this list is printed to people. */
export function driverIds(): string[] {
  return [...BY_ID.keys()].sort();
}

export function findDriverFactory(id: string): DriverFactory {
  const factory = BY_ID.get(id);
  if (!factory) {
    throw new ConfigError(
      `No driver named "${id}".`,
      `Known drivers: ${driverIds().join(', ')}`,
    );
  }
  return factory;
}

/**
 * Build a driver with whatever the config holds for it. Credential validation
 * belongs to the driver, so a missing token surfaces as that driver's own
 * actionable ConfigError rather than a generic one from here.
 */
export function createDriver(
  id: string,
  credentials: Record<string, unknown> | undefined,
): ForgeDriver {
  return findDriverFactory(id).create(credentials);
}

/** The common case: a driver id and the loaded config it should draw from. */
export function createDriverFromConfig(id: string, config: ChymeConfig): ForgeDriver {
  return createDriver(id, config.credentials[id]);
}
