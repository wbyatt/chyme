import type { ForgeActor } from '../../domain/types.js';
import { bool, fromBool, int, text, textOrNull, type Row } from '../columns.js';
import type { Db } from '../db.js';

/**
 * Actors are scoped to a source, not to a project. The same human on two
 * forges is two rows, and merging them is an identity problem this layer has no
 * evidence to solve — a handle collision across forges is a coincidence, not a
 * person.
 */
export interface ActorRow {
  id: number;
  sourceId: number;
  externalId: string;
  handle: string;
  displayName: string | null;
  isBot: boolean;
}

function toActor(row: Row): ActorRow {
  return {
    id: int(row, 'id'),
    sourceId: int(row, 'source_id'),
    externalId: text(row, 'external_id'),
    handle: text(row, 'handle'),
    displayName: textOrNull(row, 'display_name'),
    isBot: bool(row, 'is_bot'),
  };
}

const COLUMNS = 'id, source_id, external_id, handle, display_name, is_bot';

/**
 * Idempotent on (source, external_id) — the forge's own id, not the handle,
 * because people rename themselves and a digest that loses their history when
 * they do is broken.
 */
export function upsertActor(db: Db, sourceId: number, actor: ForgeActor): ActorRow {
  const row = db
    .prepare(
      `INSERT INTO actor (source_id, external_id, handle, display_name, is_bot)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_id, external_id) DO UPDATE SET
         handle = excluded.handle,
         display_name = excluded.display_name,
         is_bot = excluded.is_bot
       RETURNING ${COLUMNS}`,
    )
    .get(sourceId, actor.externalId, actor.handle, actor.displayName, fromBool(actor.isBot));
  return toActor(row!);
}

/** Convenience for the write paths, which mostly need the id and tolerate null. */
export function upsertActorId(db: Db, sourceId: number, actor: ForgeActor | null): number | null {
  return actor ? upsertActor(db, sourceId, actor).id : null;
}

export function findActor(db: Db, sourceId: number, externalId: string): ActorRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM actor WHERE source_id = ? AND external_id = ?`)
    .get(sourceId, externalId);
  return row ? toActor(row) : null;
}

export function getActor(db: Db, id: number): ActorRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM actor WHERE id = ?`).get(id);
  return row ? toActor(row) : null;
}

export function listActors(db: Db, sourceId: number): ActorRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM actor WHERE source_id = ? ORDER BY handle`)
    .all(sourceId)
    .map(toActor);
}
