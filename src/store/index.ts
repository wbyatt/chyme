import { openDatabase, transaction, type Db, type OpenOptions } from './db.js';
import { assertReadable, migrate } from './migrate.js';
import { LATEST_VERSION } from './migrations.js';
import * as actors from './repositories/actors.js';
import * as cursors from './repositories/cursors.js';
import * as digests from './repositories/digests.js';
import * as events from './repositories/events.js';
import * as fileChanges from './repositories/fileChanges.js';
import * as projects from './repositories/projects.js';
import * as references from './repositories/references.js';
import * as sources from './repositories/sources.js';
import * as threads from './repositories/threads.js';
import { createFtsSearchIndex, type SearchIndex } from './search.js';

/**
 * Wiring only.
 *
 * The repositories are plain functions taking a `Db` so they can be tested and
 * composed without a container; this file binds one open database to them so
 * callers do not thread the handle through every call. Anything with an opinion
 * about *what* to store belongs in a repository, and anything with an opinion
 * about when belongs in the sync engine — neither belongs here.
 */

/** A repository module with its `db` argument already applied. */
type Bound<T> = {
  [K in keyof T]: T[K] extends (db: Db, ...args: infer A) => infer R ? (...args: A) => R : never;
};

function bind<T extends object>(db: Db, repository: T): Bound<T> {
  const bound: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(repository)) {
    if (typeof member === 'function') {
      bound[name] = (...args: unknown[]) =>
        (member as (...applied: unknown[]) => unknown)(db, ...args);
    }
  }
  return bound as Bound<T>;
}

export interface Store {
  /** Escape hatch for one-off queries; prefer a repository function. */
  readonly db: Db;
  readonly path: string;

  readonly projects: Bound<typeof projects>;
  readonly sources: Bound<typeof sources>;
  readonly actors: Bound<typeof actors>;
  readonly threads: Bound<typeof threads>;
  readonly events: Bound<typeof events>;
  readonly fileChanges: Bound<typeof fileChanges>;
  readonly references: Bound<typeof references>;
  readonly digests: Bound<typeof digests>;
  readonly cursors: Bound<typeof cursors>;
  readonly search: SearchIndex;

  /** Atomic across every repository; nests safely. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface StoreOptions extends OpenOptions {
  /** Off only for a read-only inspection of a database we must not alter. */
  migrate?: boolean;
}

export function openStore(path: string, options: StoreOptions = {}): Store {
  const db = openDatabase(path, options);

  try {
    assertReadable(db, LATEST_VERSION);
    if (options.migrate !== false) migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    db,
    path,
    projects: bind(db, projects),
    sources: bind(db, sources),
    actors: bind(db, actors),
    threads: bind(db, threads),
    events: bind(db, events),
    fileChanges: bind(db, fileChanges),
    references: bind(db, references),
    digests: bind(db, digests),
    cursors: bind(db, cursors),
    search: createFtsSearchIndex(db),
    transaction: (fn) => transaction(db, fn),
    close: () => db.close(),
  };
}

export { transaction, type Db, type OpenOptions } from './db.js';
export { currentVersion, migrate, type MigrateResult } from './migrate.js';
export { LATEST_VERSION, MIGRATIONS, type Migration } from './migrations.js';
export {
  createFtsSearchIndex,
  toMatchExpression,
  type IndexedEvent,
  type IndexedThread,
  type SearchEntityKind,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
} from './search.js';
export type { ActorRow } from './repositories/actors.js';
export type { CursorRow } from './repositories/cursors.js';
export type { DigestInput, DigestMetaRow, DigestRow } from './repositories/digests.js';
export type { EventRow } from './repositories/events.js';
export type {
  FileChangeRow,
  FileChangeSummary,
} from './repositories/fileChanges.js';
export type { ProjectInput, ProjectRow } from './repositories/projects.js';
export type {
  ReferenceOwner,
  ReferenceRow,
  ReferenceSource,
} from './repositories/references.js';
export type { SourceInput, SourceRow } from './repositories/sources.js';
export type { ThreadInput, ThreadRow } from './repositories/threads.js';
