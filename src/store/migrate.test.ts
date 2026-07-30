import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChymeError } from '../util/errors.js';
import { openDatabase } from './db.js';
import { assertReadable, currentVersion, migrate } from './migrate.js';
import { LATEST_VERSION, MIGRATIONS } from './migrations.js';

const temporaryDirectories: string[] = [];

function tempPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'chyme-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', name);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

describe('migrate', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_VERSION);
    expect(result.applied.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    expect(currentVersion(db)).toBe(LATEST_VERSION);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'actor',
        'digest',
        'event',
        'file_change',
        'project',
        'reference',
        'search_index',
        'source',
        'sync_cursor',
        'thread',
      ]),
    );
    db.close();
  });

  it('is a no-op the second time', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = tableNames(db);

    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.from).toBe(LATEST_VERSION);
    expect(second.to).toBe(LATEST_VERSION);
    expect(tableNames(db)).toEqual(before);
    db.close();
  });

  it('leaves existing rows alone when re-run', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare("INSERT INTO project (slug, name, created_at) VALUES ('acme', 'Acme', 'now')").run();

    migrate(db);

    expect(db.prepare('SELECT count(*) AS n FROM project').get()?.n).toBe(1);
    db.close();
  });

  it('creates the parent directory and enables WAL for a file database', () => {
    const path = tempPath('chyme.db');
    const db = openDatabase(path);
    migrate(db);

    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    db.close();

    const reopened = openDatabase(path);
    expect(currentVersion(reopened)).toBe(LATEST_VERSION);
    expect(migrate(reopened).applied).toEqual([]);
    reopened.close();
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO thread (source_id, external_id, kind, number, title, state, url,
             created_at, updated_at, first_seen_at, last_synced_at)
           VALUES (999, 'x', 'issue', 1, 't', 'open', 'u', 'a', 'b', 'c', 'd')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('refuses a database written by a newer Chyme', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 5}`);

    expect(() => assertReadable(db, LATEST_VERSION)).toThrow(ChymeError);
    db.close();
  });

  it('rolls the whole run back when a migration fails', () => {
    const db = openDatabase(':memory:');

    expect(() =>
      migrate(db, [
        { version: 1, name: 'ok', up: 'CREATE TABLE first (id INTEGER PRIMARY KEY)' },
        { version: 2, name: 'broken', up: 'CREATE TABLE this is not sql' },
      ]),
    ).toThrow(ChymeError);

    expect(currentVersion(db)).toBe(0);
    expect(tableNames(db)).not.toContain('first');
    db.close();
  });
});
