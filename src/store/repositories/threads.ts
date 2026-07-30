import type { ThreadSummary, ThreadKind, ThreadState } from '../../domain/types.js';
import {
  bool,
  decodeJsonArray,
  encodeJson,
  fromBool,
  int,
  intOrNull,
  text,
  textOrNull,
  type Row,
} from '../columns.js';
import type { Db } from '../db.js';
import { upsertActorId } from './actors.js';

export interface ThreadRow {
  id: number;
  sourceId: number;
  externalId: string;
  kind: ThreadKind;
  number: number;
  title: string;
  state: ThreadState;
  isDraft: boolean;
  authorId: number | null;
  url: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  labels: string[];
  /** When Chyme first recorded this thread — not when the source created it. */
  firstSeenAt: string;
  lastSyncedAt: string;
}

export interface ThreadInput extends ThreadSummary {
  /**
   * Omit on a listing-pass upsert and the stored body is left alone; pass
   * `null` explicitly to record that the description was cleared. The
   * distinction matters because sync writes summaries and details separately.
   */
  body?: string | null;
}

function toThread(row: Row): ThreadRow {
  return {
    id: int(row, 'id'),
    sourceId: int(row, 'source_id'),
    externalId: text(row, 'external_id'),
    // Written only by this module from the domain unions, so the stored text is
    // one of them by construction.
    kind: text(row, 'kind') as ThreadKind,
    number: int(row, 'number'),
    title: text(row, 'title'),
    state: text(row, 'state') as ThreadState,
    isDraft: bool(row, 'is_draft'),
    authorId: intOrNull(row, 'author_id'),
    url: text(row, 'url'),
    body: textOrNull(row, 'body'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    closedAt: textOrNull(row, 'closed_at'),
    mergedAt: textOrNull(row, 'merged_at'),
    labels: decodeJsonArray<string>(row, 'labels_json'),
    firstSeenAt: text(row, 'first_seen_at'),
    lastSyncedAt: text(row, 'last_synced_at'),
  };
}

const COLUMNS = `id, source_id, external_id, kind, number, title, state, is_draft, author_id, url,
  body, created_at, updated_at, closed_at, merged_at, labels_json, first_seen_at, last_synced_at`;

/**
 * Idempotent on (source, kind, number).
 *
 * `first_seen_at` survives every re-sync: it is Chyme's own observation
 * timestamp, and rewriting it would make "new since last time" mean "synced
 * most recently", which is a different and much less useful question.
 */
export function upsertThread(
  db: Db,
  sourceId: number,
  input: ThreadInput,
  syncedAt: string,
): ThreadRow {
  const authorId = upsertActorId(db, sourceId, input.author);
  const writesBody = 'body' in input;

  const row = db
    .prepare(
      `INSERT INTO thread (
         source_id, external_id, kind, number, title, state, is_draft, author_id, url, body,
         created_at, updated_at, closed_at, merged_at, labels_json, raw_json,
         first_seen_at, last_synced_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, kind, number) DO UPDATE SET
         external_id = excluded.external_id,
         title = excluded.title,
         state = excluded.state,
         is_draft = excluded.is_draft,
         author_id = COALESCE(excluded.author_id, thread.author_id),
         url = excluded.url,
         ${writesBody ? 'body = excluded.body,' : ''}
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at,
         merged_at = excluded.merged_at,
         labels_json = excluded.labels_json,
         raw_json = excluded.raw_json,
         last_synced_at = excluded.last_synced_at
       RETURNING ${COLUMNS}`,
    )
    .get(
      sourceId,
      input.externalId,
      input.kind,
      input.number,
      input.title,
      input.state,
      fromBool(input.isDraft),
      authorId,
      input.url,
      writesBody ? (input.body ?? null) : null,
      input.createdAt,
      input.updatedAt,
      input.closedAt,
      input.mergedAt,
      encodeJson(input.labels),
      encodeJson(input.raw),
      syncedAt,
      syncedAt,
    );

  return toThread(row!);
}

export function findThread(
  db: Db,
  sourceId: number,
  kind: ThreadKind,
  number: number,
): ThreadRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM thread WHERE source_id = ? AND kind = ? AND number = ?`)
    .get(sourceId, kind, number);
  return row ? toThread(row) : null;
}

export function getThread(db: Db, id: number): ThreadRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM thread WHERE id = ?`).get(id);
  return row ? toThread(row) : null;
}

/** The driver's untouched payload, read back only when a mapper needs it. */
export function getThreadRaw(db: Db, id: number): unknown {
  const row = db.prepare('SELECT raw_json FROM thread WHERE id = ?').get(id);
  if (!row) return null;
  const raw = textOrNull(row, 'raw_json');
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

export function listThreadsForSource(db: Db, sourceId: number): ThreadRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM thread WHERE source_id = ? ORDER BY updated_at DESC`)
    .all(sourceId)
    .map(toThread);
}

/**
 * Threads a project touched inside a window. Half-open on the end so adjacent
 * digest windows neither overlap nor drop the instant between them.
 */
export function listThreadsUpdatedBetween(
  db: Db,
  projectId: number,
  start: string,
  end: string,
): ThreadRow[] {
  // A subquery rather than a join: `thread` and `source` share `id` and
  // `created_at`, and joining them would make an unqualified column list
  // ambiguous for no gain — the source_id index serves this either way.
  return db
    .prepare(
      `SELECT ${COLUMNS}
       FROM thread
       WHERE source_id IN (SELECT id FROM source WHERE project_id = ?)
         AND updated_at >= ? AND updated_at < ?
       ORDER BY updated_at`,
    )
    .all(projectId, start, end)
    .map(toThread);
}

export function countThreads(db: Db, projectId: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM thread
       WHERE source_id IN (SELECT id FROM source WHERE project_id = ?)`,
    )
    .get(projectId);
  return row ? int(row, 'n') : 0;
}

/** Cascades to the thread's events, file changes, references and search rows. */
export function deleteThread(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM thread WHERE id = ?').run(id).changes > 0;
}
