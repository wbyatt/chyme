import { ChymeError } from './errors.js';

/**
 * A `--since` / `--until` argument before it has been resolved against the
 * store. `last` needs a database lookup (the end of the most recent saved
 * digest window), so parsing and resolution are separate steps.
 */
export type TimeSpec =
  | { kind: 'last' }
  | { kind: 'instant'; at: string };

const RELATIVE = /^(\d+)\s*(m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** ISO 8601 UTC with second precision — the only timestamp format Chyme stores. */
export function toIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse a time expression: `last`, a relative offset (`7d`, `36h`, `2w`), a
 * calendar date (`2026-07-01`), or a full ISO 8601 timestamp.
 *
 * `now` is injected rather than read from the clock so this stays testable.
 */
export function parseTimeSpec(input: string, now: Date): TimeSpec {
  const value = input.trim();
  if (value === '') {
    throw new ChymeError('Empty time expression.', 'Try: last, 7d, or 2026-07-01');
  }

  if (value.toLowerCase() === 'last') {
    return { kind: 'last' };
  }

  const relative = RELATIVE.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const step = UNIT_MS[unit]!;
    if (amount === 0) {
      throw new ChymeError(`"${value}" is a zero-length window.`);
    }
    return { kind: 'instant', at: toIso(new Date(now.getTime() - amount * step)) };
  }

  // A bare calendar date means the start of that day, UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new ChymeError(`"${value}" is not a real date.`);
    }
    return { kind: 'instant', at: toIso(parsed) };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ChymeError(
      `Could not read "${value}" as a time.`,
      'Accepted: last, a relative offset like 7d or 36h, a date like 2026-07-01, or an ISO 8601 timestamp.',
    );
  }
  return { kind: 'instant', at: toIso(parsed) };
}

/** Human-friendly elapsed time, e.g. "3d ago". Used only in rendered output. */
export function describeAge(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const deltaMs = now.getTime() - then;
  if (deltaMs < 0) return 'in the future';

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
