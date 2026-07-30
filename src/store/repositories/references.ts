import type { ExtractedReference } from '../../domain/types.js';
import { decodeJson, encodeJson, int, intOrNull, real, text, textOrNull, type Row } from '../columns.js';
import { transaction, type Db } from '../db.js';

/**
 * The entities that carry free text and can therefore point at something.
 * Deliberately not an FK column: an edge from a thread and an edge from an
 * event live in one table so a query for "what does this work touch" is one
 * scan rather than a union.
 */
export type ReferenceSource = 'thread' | 'event';

export interface ReferenceOwner {
  kind: ReferenceSource;
  id: number;
}

export interface ReferenceRow {
  id: number;
  from: ReferenceOwner;
  /** Open vocabulary: 'thread' | 'commit' | 'url' | 'ticket' | driver-specific. */
  refKind: string;
  refRaw: string;
  /** The driver's disambiguation hint, kept so resolution can happen later. */
  hint: Record<string, unknown> | null;
  toKind: string | null;
  toId: number | null;
  /**
   * How sure we are of `to`. Zero means unresolved, which is the state every
   * reference starts in — recording an unresolvable "PROJ-88" is still worth
   * doing, because it becomes resolvable the day a Jira driver exists.
   */
  confidence: number;
}

function toReference(row: Row): ReferenceRow {
  return {
    id: int(row, 'id'),
    from: { kind: text(row, 'from_kind') as ReferenceSource, id: int(row, 'from_id') },
    refKind: text(row, 'ref_kind'),
    refRaw: text(row, 'ref_raw'),
    hint: decodeJson<Record<string, unknown>>(row, 'hint_json'),
    toKind: textOrNull(row, 'to_kind'),
    toId: intOrNull(row, 'to_id'),
    confidence: real(row, 'confidence'),
  };
}

const COLUMNS = 'id, from_kind, from_id, ref_kind, ref_raw, hint_json, to_kind, to_id, confidence';

/**
 * Note what is *not* in the conflict update: `to_kind`, `to_id` and
 * `confidence`. Extraction is a syntactic pass and knows nothing about
 * resolution, so re-running it over an edited comment must not throw away a
 * resolution that a later pass worked out.
 */
const UPSERT = `INSERT INTO reference (from_kind, from_id, ref_kind, ref_raw, hint_json)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (from_kind, from_id, ref_kind, ref_raw) DO UPDATE SET hint_json = excluded.hint_json
  RETURNING ${COLUMNS}`;

/**
 * Set the complete list of references found in one entity's text. Edges that
 * are no longer present are removed, because a reference deleted from an edited
 * comment is a reference the author took back.
 */
export function replaceReferences(
  db: Db,
  from: ReferenceOwner,
  references: readonly ExtractedReference[],
): ReferenceRow[] {
  return transaction(db, () => {
    const upsert = db.prepare(UPSERT);
    const rows = references.map((reference) => {
      const row = upsert.get(
        from.kind,
        from.id,
        reference.refKind,
        reference.refRaw,
        encodeJson(reference.hint),
      );
      return toReference(row!);
    });

    const keep = rows.map((row) => row.id);
    const placeholders = keep.map(() => '?').join(', ');
    db.prepare(
      keep.length === 0
        ? 'DELETE FROM reference WHERE from_kind = ? AND from_id = ?'
        : `DELETE FROM reference WHERE from_kind = ? AND from_id = ? AND id NOT IN (${placeholders})`,
    ).run(from.kind, from.id, ...keep);

    return rows;
  });
}

/** Record what a reference turned out to point at. */
export function resolveReference(
  db: Db,
  id: number,
  to: { kind: string; id: number },
  confidence: number,
): boolean {
  return (
    db
      .prepare('UPDATE reference SET to_kind = ?, to_id = ?, confidence = ? WHERE id = ?')
      .run(to.kind, to.id, confidence, id).changes > 0
  );
}

export function listReferencesFrom(db: Db, from: ReferenceOwner): ReferenceRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM reference WHERE from_kind = ? AND from_id = ? ORDER BY id`)
    .all(from.kind, from.id)
    .map(toReference);
}

/** The reverse edge: everything that points at this thing. */
export function listReferencesTo(db: Db, toKind: string, toId: number): ReferenceRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM reference WHERE to_kind = ? AND to_id = ? ORDER BY id`)
    .all(toKind, toId)
    .map(toReference);
}

/** Candidates for a later resolution pass, e.g. once a second driver exists. */
export function listUnresolvedReferences(db: Db, refKind?: string, limit = 500): ReferenceRow[] {
  const sql =
    refKind === undefined
      ? `SELECT ${COLUMNS} FROM reference WHERE to_id IS NULL ORDER BY id LIMIT ?`
      : `SELECT ${COLUMNS} FROM reference WHERE to_id IS NULL AND ref_kind = ? ORDER BY id LIMIT ?`;
  const args = refKind === undefined ? [limit] : [refKind, limit];
  return db
    .prepare(sql)
    .all(...args)
    .map(toReference);
}

/**
 * Drop every edge out of one entity. Deleting the thread or event itself is
 * already handled by a trigger; this is for the case where the entity stays but
 * its references should not, e.g. after a re-extraction pass is abandoned.
 */
export function deleteReferencesFrom(db: Db, from: ReferenceOwner): number {
  const result = db
    .prepare('DELETE FROM reference WHERE from_kind = ? AND from_id = ?')
    .run(from.kind, from.id);
  return Number(result.changes);
}
