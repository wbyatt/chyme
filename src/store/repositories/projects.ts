import { NotFoundError } from '../../util/errors.js';
import { int, text, type Row } from '../columns.js';
import type { Db } from '../db.js';

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
}

export interface ProjectInput {
  slug: string;
  name: string;
}

function toProject(row: Row): ProjectRow {
  return {
    id: int(row, 'id'),
    slug: text(row, 'slug'),
    name: text(row, 'name'),
    createdAt: text(row, 'created_at'),
  };
}

const COLUMNS = 'id, slug, name, created_at';

/**
 * Idempotent on `slug`. The name may be edited in the config, so it is updated;
 * `created_at` is when we first saw the project and is never rewritten.
 *
 * RETURNING is used throughout the repositories rather than `lastInsertRowid`,
 * because on the conflict path no row is inserted and the rowid would be stale.
 */
export function upsertProject(db: Db, input: ProjectInput, now: string): ProjectRow {
  const row = db
    .prepare(
      `INSERT INTO project (slug, name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name
       RETURNING ${COLUMNS}`,
    )
    .get(input.slug, input.name, now);
  return toProject(row!);
}

export function findProject(db: Db, slug: string): ProjectRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM project WHERE slug = ?`).get(slug);
  return row ? toProject(row) : null;
}

export function requireProject(db: Db, slug: string): ProjectRow {
  const project = findProject(db, slug);
  if (!project) {
    throw new NotFoundError(
      `Project "${slug}" is not in the store.`,
      'Run `chyme sync` first, or check `chyme project list`.',
    );
  }
  return project;
}

export function getProject(db: Db, id: number): ProjectRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM project WHERE id = ?`).get(id);
  return row ? toProject(row) : null;
}

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM project ORDER BY slug`).all().map(toProject);
}

/** Cascades to sources, threads, events and digests. */
export function deleteProject(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM project WHERE id = ?').run(id).changes > 0;
}
