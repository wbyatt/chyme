import { decodeJson, encodeJson, int, text, type Row } from '../columns.js';
import type { Db } from '../db.js';

/**
 * A saved digest is what makes `--since last` mean anything: the end of the
 * most recent window is where the next one starts, so a user who reads a digest
 * on Monday and again on Thursday gets Tuesday and Wednesday exactly once.
 */
export interface DigestRow {
  id: number;
  projectId: number;
  windowStart: string;
  windowEnd: string;
  /** How the digest was asked for, so it can be reproduced or explained. */
  params: Record<string, unknown> | null;
  bodyMd: string;
  createdAt: string;
}

export interface DigestInput {
  projectId: number;
  windowStart: string;
  windowEnd: string;
  params?: Record<string, unknown> | null;
  bodyMd: string;
}

function toDigest(row: Row): DigestRow {
  return {
    id: int(row, 'id'),
    projectId: int(row, 'project_id'),
    windowStart: text(row, 'window_start'),
    windowEnd: text(row, 'window_end'),
    params: decodeJson<Record<string, unknown>>(row, 'params_json'),
    bodyMd: text(row, 'body_md'),
    createdAt: text(row, 'created_at'),
  };
}

const COLUMNS = 'id, project_id, window_start, window_end, params_json, body_md, created_at';

/**
 * Insert, never upsert: two digests over the same window are two distinct
 * readings — the second one saw more, because more had happened.
 */
export function insertDigest(db: Db, input: DigestInput, now: string): DigestRow {
  const row = db
    .prepare(
      `INSERT INTO digest (project_id, window_start, window_end, params_json, body_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      input.projectId,
      input.windowStart,
      input.windowEnd,
      encodeJson(input.params ?? null),
      input.bodyMd,
      now,
    );
  return toDigest(row!);
}

/**
 * The digest whose window reaches furthest forward, which is what `last`
 * resolves to. Ordering by `window_end` rather than `created_at` is deliberate:
 * re-running an older window afterwards must not rewind the watermark.
 */
export function latestDigest(db: Db, projectId: number): DigestRow | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM digest WHERE project_id = ?
       ORDER BY window_end DESC, id DESC LIMIT 1`,
    )
    .get(projectId);
  return row ? toDigest(row) : null;
}

export function getDigest(db: Db, id: number): DigestRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM digest WHERE id = ?`).get(id);
  return row ? toDigest(row) : null;
}

export type DigestMetaRow = Omit<DigestRow, 'bodyMd'>;

/** Newest first. `body_md` is omitted; use `getDigest` to read one. */
export function listDigests(db: Db, projectId: number, limit = 20): DigestMetaRow[] {
  return db
    .prepare(
      `SELECT id, project_id, window_start, window_end, params_json, created_at
       FROM digest WHERE project_id = ? ORDER BY window_end DESC, id DESC LIMIT ?`,
    )
    .all(projectId, limit)
    .map((row) => ({
      id: int(row, 'id'),
      projectId: int(row, 'project_id'),
      windowStart: text(row, 'window_start'),
      windowEnd: text(row, 'window_end'),
      params: decodeJson<Record<string, unknown>>(row, 'params_json'),
      createdAt: text(row, 'created_at'),
    }));
}

/**
 * How many the project has, which is not the same as how many `listDigests`
 * returned. A listing that shows a page has to say so, and it cannot say so
 * from the page.
 */
export function countDigests(db: Db, projectId: number): number {
  const row = db.prepare('SELECT count(*) AS n FROM digest WHERE project_id = ?').get(projectId);
  return row ? int(row, 'n') : 0;
}

export function deleteDigest(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM digest WHERE id = ?').run(id).changes > 0;
}
