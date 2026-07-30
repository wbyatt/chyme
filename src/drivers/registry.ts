import { ConfigError } from '../util/errors.js';
import { credentialsFor } from '../config/load.js';
import type { ChymeConfig } from '../config/schema.js';
import { githubDriverFactory } from './github/index.js';
import type { ThreadKind } from '../domain/types.js';
import type { DriverFactory, SourceDriver } from './types.js';

/**
 * The one place that knows which sources exist.
 *
 * A driver id in the config is a promise that something can service it, and
 * this is where that promise is kept or refused. Adding a source is one entry
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

/**
 * Every thread kind any registered driver can service.
 *
 * Commands that filter across a whole project cannot know which driver a kind
 * belongs to, so this is what they validate against — narrow enough to catch a
 * typo, open enough that adding a source type needs no change here.
 */
export function supportedThreadKinds(): ThreadKind[] {
  const kinds = new Set<ThreadKind>();
  for (const factory of FACTORIES) {
    for (const kind of factory.supportedKinds) kinds.add(kind);
  }
  return [...kinds].sort();
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
): SourceDriver {
  return findDriverFactory(id).create(credentials);
}

/**
 * The common case: a driver id and the loaded config it should draw from.
 * Credentials are interpolated here rather than at config load, so the read-only
 * commands never need a token to be present.
 */
export function createDriverFromConfig(id: string, config: ChymeConfig): SourceDriver {
  return createDriver(id, credentialsFor(config, id));
}
