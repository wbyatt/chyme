import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChymeError } from '../util/errors.js';

/**
 * Database handle and transaction control.
 *
 * `node:sqlite` is used deliberately over a native binding: Chyme is a CLI that
 * people install with `npm i -g`, and a package that needs a compiler on the
 * user's machine is a package that fails to install on someone's laptop.
 */
export type Db = DatabaseSync;

export interface OpenOptions {
  /** How long to wait on a lock before giving up. Two syncs can overlap. */
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** In-memory and URI forms have no parent directory to create. */
function isFilePath(path: string): boolean {
  return path !== ':memory:' && !path.startsWith('file:');
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const readOnly = options.readOnly ?? false;

  if (isFilePath(path) && !readOnly) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  let db: Db;
  try {
    db = new DatabaseSync(path, {
      // sqlite-vec will be loaded here later; nothing is loaded today. The flag
      // has to be set at open time, so it is set now rather than forcing a
      // reopen when vector search lands.
      allowExtension: true,
      enableForeignKeyConstraints: true,
      readOnly,
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    throw new ChymeError(
      `Could not open the database at ${path}: ${(error as Error).message}`,
      'Check the path is writable, or set CHYME_DB to somewhere it is.',
    );
  }

  if (!readOnly) {
    // WAL keeps a long sync from blocking a concurrent read. It is a no-op on
    // in-memory databases, which report journal_mode=memory and carry on.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  // Belt and braces for trigger cascades. An earlier comment here claimed the
  // search index and reference edges would rot without it; that was tested and
  // is false on SQLite 3.51 — the cleanup triggers fire either way, because a
  // foreign-key cascade counts as a top-level delete rather than a recursive
  // one. It is kept because it makes the depth of trigger nesting explicit
  // rather than dependent on a compile-time default, but nothing here relies
  // on it.
  db.exec('PRAGMA recursive_triggers = ON');

  return db;
}

let savepointDepth = 0;

/**
 * Run `fn` atomically, rolling back on any throw.
 *
 * Nested calls become savepoints rather than a second BEGIN, so a repository
 * that wraps its own writes stays composable inside a larger sync transaction
 * instead of failing with "cannot start a transaction within a transaction".
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `chyme_sp_${savepointDepth++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      // The original failure is the one worth reporting. If unwinding also
      // fails, letting that replace it would hide the cause behind its own
      // side effect.
      unwind(db, `ROLLBACK TO ${name}`);
      unwind(db, `RELEASE ${name}`);
      throw error;
    } finally {
      savepointDepth--;
    }
  }

  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    unwind(db, 'ROLLBACK');
    throw error;
  }
}

/** Best-effort unwind on the error path; never masks the error being thrown. */
function unwind(db: Db, statement: string): void {
  try {
    db.exec(statement);
  } catch {
    // Nothing useful to do: we are already unwinding, and the caller is about
    // to see the failure that got us here.
  }
}
