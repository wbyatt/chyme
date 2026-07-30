/**
 * Column coercion.
 *
 * `node:sqlite` hands back `Record<string, null | number | bigint | string |
 * Uint8Array>`. Without a single place to narrow that, every repository grows
 * its own casts and the first schema drift shows up as `undefined` three layers
 * downstream instead of at the row that produced it. A wrong column type here
 * is a bug in this package, not user error, so these throw plain `TypeError`
 * rather than `ChymeError` — a stack trace is the useful output.
 */

export type Row = Record<string, unknown>;

function fail(row: Row, column: string, expected: string): never {
  const actual = column in row ? `${typeof row[column]} (${String(row[column])})` : 'missing';
  throw new TypeError(`Column "${column}" should be ${expected}, got ${actual}`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') fail(row, column, 'text');
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(row, column, 'text or null');
  return value;
}

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fail(row, column, 'an integer');
}

export function intOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return int(row, column);
}

export function real(row: Row, column: string): number {
  return int(row, column);
}

/** SQLite has no boolean type; 0/1 is the storage convention throughout. */
export function bool(row: Row, column: string): boolean {
  return int(row, column) !== 0;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * `undefined` and unserializable values collapse to NULL rather than to the
 * string "undefined", which would survive a round trip and poison JSON.parse.
 */
export function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

/**
 * Stored JSON is our own or a driver's payload, but a truncated write or a
 * hand-edited database should degrade to null rather than crash a digest run.
 */
export function decodeJson<T>(row: Row, column: string): T | null {
  const raw = textOrNull(row, column);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function decodeJsonArray<T>(row: Row, column: string): T[] {
  const parsed = decodeJson<unknown>(row, column);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}
