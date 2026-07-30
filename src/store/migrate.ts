import { ChymeError } from '../util/errors.js';
import { int } from './columns.js';
import { transaction, type Db } from './db.js';
import { MIGRATIONS, type Migration } from './migrations.js';

/**
 * `PRAGMA user_version` is the whole of the bookkeeping. A migrations table
 * would record more, but it is one more thing to keep consistent with the
 * integer that actually gates the next run, and there is nothing here that
 * needs a second source of truth.
 */
export function currentVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get();
  return row ? int(row, 'user_version') : 0;
}

function setVersion(db: Db, version: number): void {
  // PRAGMA does not take bound parameters, hence the interpolation. `version`
  // comes from the migration list in this package, never from input.
  db.exec(`PRAGMA user_version = ${version}`);
}

function apply(db: Db, migration: Migration): void {
  try {
    if (typeof migration.up === 'string') {
      db.exec(migration.up);
    } else {
      migration.up(db);
    }
  } catch (error) {
    throw new ChymeError(
      `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
      'The database was left untouched. This is a bug in Chyme; please report it.',
    );
  }
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: Migration[];
}

/**
 * Bring the schema up to date. Running this against an already-current database
 * does nothing, so it is safe to call on every command.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const from = currentVersion(db);
  const pending = ordered.filter((migration) => migration.version > from);

  if (pending.length === 0) return { from, to: from, applied: [] };

  const newest = pending[pending.length - 1]!.version;

  // One transaction for the whole run: a half-migrated database is worse than
  // an unmigrated one, because the version says it is fine.
  transaction(db, () => {
    for (const migration of pending) apply(db, migration);
    setVersion(db, newest);
  });

  return { from, to: newest, applied: pending };
}

/**
 * A database written by a newer Chyme is not something an older one can read
 * safely, and silently ignoring the unknown tables would produce a digest with
 * holes in it.
 */
export function assertReadable(db: Db, latest: number): void {
  const version = currentVersion(db);
  if (version > latest) {
    throw new ChymeError(
      `The database was created by a newer version of Chyme (schema ${version}, this build understands ${latest}).`,
      'Upgrade Chyme: npm i -g chyme',
    );
  }
}
