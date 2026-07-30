import type { FileChangeStatus, ForgeFileChange } from '../../domain/types.js';
import { bool, fromBool, int, text, textOrNull, type Row } from '../columns.js';
import { transaction, type Db } from '../db.js';

/**
 * Everything about a file's participation in a change except the diff text,
 * which dominates the row size and is not needed to say which files were
 * touched.
 */
export interface FileChangeSummary {
  id: number;
  threadId: number;
  path: string;
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /**
   * The forge withheld the patch or it was over budget. Never let a missing
   * patch read as an empty one — "no diff" and "we did not fetch the diff" are
   * opposite conclusions.
   */
  patchTruncated: boolean;
}

export interface FileChangeRow extends FileChangeSummary {
  patch: string | null;
}

function toSummary(row: Row): FileChangeSummary {
  return {
    id: int(row, 'id'),
    threadId: int(row, 'thread_id'),
    path: text(row, 'path'),
    previousPath: textOrNull(row, 'previous_path'),
    // Written only by this module from the domain union.
    status: text(row, 'status') as FileChangeStatus,
    additions: int(row, 'additions'),
    deletions: int(row, 'deletions'),
    patchTruncated: bool(row, 'patch_truncated'),
  };
}

function toFileChange(row: Row): FileChangeRow {
  return { ...toSummary(row), patch: textOrNull(row, 'patch') };
}

const SUMMARY_COLUMNS = `id, thread_id, path, previous_path, status, additions, deletions, patch_truncated`;
const COLUMNS = `${SUMMARY_COLUMNS}, patch`;

const UPSERT = `INSERT INTO file_change (
    thread_id, path, previous_path, status, additions, deletions, patch, patch_truncated
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (thread_id, path) DO UPDATE SET
    previous_path = excluded.previous_path,
    status = excluded.status,
    additions = excluded.additions,
    deletions = excluded.deletions,
    patch = excluded.patch,
    patch_truncated = excluded.patch_truncated
  RETURNING ${COLUMNS}`;

/**
 * Replace a thread's file list wholesale.
 *
 * Unlike an event, a file change is not an immutable record of something that
 * happened: it is the current state of the diff. A force-push or a reverted
 * commit removes files from a pull request, so paths absent from `files` are
 * deleted rather than left behind as phantom changes.
 *
 * Upsert-then-delete rather than delete-then-insert, so row ids survive a
 * re-sync and anything pointing at them stays valid.
 */
export function replaceFileChanges(
  db: Db,
  threadId: number,
  files: readonly ForgeFileChange[],
): FileChangeRow[] {
  return transaction(db, () => {
    const upsert = db.prepare(UPSERT);
    const rows = files.map((file) => {
      const row = upsert.get(
        threadId,
        file.path,
        file.previousPath,
        file.status,
        file.additions,
        file.deletions,
        file.patch,
        fromBool(file.patchTruncated),
      );
      return toFileChange(row!);
    });

    const keep = rows.map((row) => row.path);
    const placeholders = keep.map(() => '?').join(', ');
    db.prepare(
      keep.length === 0
        ? 'DELETE FROM file_change WHERE thread_id = ?'
        : `DELETE FROM file_change WHERE thread_id = ? AND path NOT IN (${placeholders})`,
    ).run(threadId, ...keep);

    return rows;
  });
}

export function listFileChanges(db: Db, threadId: number): FileChangeRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM file_change WHERE thread_id = ? ORDER BY path`)
    .all(threadId)
    .map(toFileChange);
}

export function listFileChangeSummaries(db: Db, threadId: number): FileChangeSummary[] {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM file_change WHERE thread_id = ? ORDER BY path`)
    .all(threadId)
    .map(toSummary);
}

export function countFileChanges(db: Db, threadId: number): number {
  const row = db.prepare('SELECT count(*) AS n FROM file_change WHERE thread_id = ?').get(threadId);
  return row ? int(row, 'n') : 0;
}
