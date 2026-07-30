import { int, text, type Row } from '../columns.js';
import type { Db } from '../db.js';

/**
 * Sync watermarks, keyed by (source, kind).
 *
 * `kind` is free text rather than a fixed column because one source keeps
 * several watermarks: pull requests and issues come from different endpoints
 * with different rate limits and often different failure modes, so they advance
 * independently. A single cursor per source would mean a failed issue page
 * rewinding a successful pull request sync.
 *
 * `value` is a string, not a timestamp, for the same reason: most forges give
 * an ISO instant, but an opaque continuation token is just as valid a
 * watermark and only the driver needs to interpret it.
 */
export interface CursorRow {
  sourceId: number;
  kind: string;
  value: string;
  updatedAt: string;
}

function toCursor(row: Row): CursorRow {
  return {
    sourceId: int(row, 'source_id'),
    kind: text(row, 'kind'),
    value: text(row, 'value'),
    updatedAt: text(row, 'updated_at'),
  };
}

const COLUMNS = 'source_id, kind, value, updated_at';

export function getCursor(db: Db, sourceId: number, kind: string): CursorRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM sync_cursor WHERE source_id = ? AND kind = ?`)
    .get(sourceId, kind);
  return row ? toCursor(row) : null;
}

/** The watermark to hand a driver, or null on a first sync. */
export function getCursorValue(db: Db, sourceId: number, kind: string): string | null {
  return getCursor(db, sourceId, kind)?.value ?? null;
}

/**
 * Set the watermark unconditionally, including backwards. This is what a
 * deliberate re-sync of older history needs; ordinary sync should use
 * `advanceCursor`.
 */
export function setCursor(
  db: Db,
  sourceId: number,
  kind: string,
  value: string,
  now: string,
): CursorRow {
  const row = db
    .prepare(
      `INSERT INTO sync_cursor (source_id, kind, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id, kind) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       RETURNING ${COLUMNS}`,
    )
    .get(sourceId, kind, value, now);
  return toCursor(row!);
}

/**
 * Move the watermark forward only.
 *
 * Comparison is lexicographic, which is exactly right for the ISO 8601 UTC
 * timestamps drivers actually emit and meaningless for opaque tokens — so a
 * driver using opaque cursors must call `setCursor` instead. The guard exists
 * because an interrupted sync that resumes and re-emits earlier threads must
 * not drag the watermark back and re-fetch a month of history next run.
 */
export function advanceCursor(
  db: Db,
  sourceId: number,
  kind: string,
  value: string,
  now: string,
): CursorRow {
  const row = db
    .prepare(
      `INSERT INTO sync_cursor (source_id, kind, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id, kind) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.value > sync_cursor.value
       RETURNING ${COLUMNS}`,
    )
    .get(sourceId, kind, value, now);

  // The conflict clause's WHERE suppressed the update, so RETURNING yields
  // nothing; the stored cursor is the newer one and stands.
  return row ? toCursor(row) : getCursor(db, sourceId, kind)!;
}

export function listCursors(db: Db, sourceId: number): CursorRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM sync_cursor WHERE source_id = ? ORDER BY kind`)
    .all(sourceId)
    .map(toCursor);
}

/** Forget the watermarks so the next sync starts from the beginning. */
export function clearCursors(db: Db, sourceId: number, kind?: string): number {
  const result =
    kind === undefined
      ? db.prepare('DELETE FROM sync_cursor WHERE source_id = ?').run(sourceId)
      : db.prepare('DELETE FROM sync_cursor WHERE source_id = ? AND kind = ?').run(sourceId, kind);
  return Number(result.changes);
}
