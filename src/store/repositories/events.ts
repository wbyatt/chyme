import type { EventKind, SourceEvent } from '../../domain/types.js';
import { decodeJson, encodeJson, int, intOrNull, text, textOrNull, type Row } from '../columns.js';
import type { Db } from '../db.js';
import { upsertActorId } from './actors.js';

export interface EventRow {
  id: number;
  threadId: number;
  externalId: string;
  kind: EventKind;
  actorId: number | null;
  createdAt: string;
  body: string | null;
  path: string | null;
  line: number | null;
  detail: Record<string, unknown> | null;
}

function toEvent(row: Row): EventRow {
  return {
    id: int(row, 'id'),
    threadId: int(row, 'thread_id'),
    externalId: text(row, 'external_id'),
    // Written only by this module from the domain union.
    kind: text(row, 'kind') as EventKind,
    actorId: intOrNull(row, 'actor_id'),
    createdAt: text(row, 'created_at'),
    body: textOrNull(row, 'body'),
    path: textOrNull(row, 'path'),
    line: intOrNull(row, 'line'),
    detail: decodeJson<Record<string, unknown>>(row, 'detail_json'),
  };
}

const COLUMNS = `id, thread_id, external_id, kind, actor_id, created_at, body, path, line, detail_json`;

const UPSERT = `INSERT INTO event (
    thread_id, external_id, kind, actor_id, created_at, body, path, line, detail_json, raw_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (thread_id, external_id) DO UPDATE SET
    kind = excluded.kind,
    actor_id = COALESCE(excluded.actor_id, event.actor_id),
    created_at = excluded.created_at,
    body = excluded.body,
    path = excluded.path,
    line = excluded.line,
    detail_json = excluded.detail_json,
    raw_json = excluded.raw_json
  RETURNING ${COLUMNS}`;

/**
 * Idempotent on (thread, external_id).
 *
 * Bodies are overwritten rather than versioned: an edited comment reads as the
 * comment now says, which is what a reader catching up would see. Keeping the
 * pre-edit text would need the source to tell us it changed, and none of them do
 * reliably.
 */
export function upsertEvents(
  db: Db,
  threadId: number,
  sourceId: number,
  events: readonly SourceEvent[],
): EventRow[] {
  if (events.length === 0) return [];

  // Prepared once for the whole thread: a busy pull request is hundreds of
  // events, and re-parsing this statement for each is the bulk of a sync's CPU.
  const statement = db.prepare(UPSERT);

  return events.map((event) => {
    const actorId = upsertActorId(db, sourceId, event.actor);
    const row = statement.get(
      threadId,
      event.externalId,
      event.kind,
      actorId,
      event.createdAt,
      event.body,
      event.path,
      event.line,
      encodeJson(event.detail),
      encodeJson(event.raw),
    );
    return toEvent(row!);
  });
}

export function upsertEvent(
  db: Db,
  threadId: number,
  sourceId: number,
  event: SourceEvent,
): EventRow {
  return upsertEvents(db, threadId, sourceId, [event])[0]!;
}

export function listEventsForThread(db: Db, threadId: number): EventRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM event WHERE thread_id = ? ORDER BY created_at, id`)
    .all(threadId)
    .map(toEvent);
}

/** Half-open window, matching `listThreadsUpdatedBetween`. */
export function listEventsBetween(
  db: Db,
  projectId: number,
  start: string,
  end: string,
): EventRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS}
       FROM event
       WHERE thread_id IN (
         SELECT id FROM thread
         WHERE source_id IN (SELECT id FROM source WHERE project_id = ?)
       )
       AND created_at >= ? AND created_at < ?
       ORDER BY created_at, id`,
    )
    .all(projectId, start, end)
    .map(toEvent);
}

export function countEventsForThread(db: Db, threadId: number): number {
  const row = db.prepare('SELECT count(*) AS n FROM event WHERE thread_id = ?').get(threadId);
  return row ? int(row, 'n') : 0;
}

export function getEventRaw(db: Db, id: number): unknown {
  const row = db.prepare('SELECT raw_json FROM event WHERE id = ?').get(id);
  if (!row) return null;
  const raw = textOrNull(row, 'raw_json');
  return raw === null ? null : (JSON.parse(raw) as unknown);
}
