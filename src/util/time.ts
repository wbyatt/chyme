import { ChymeError } from './errors.js';

/**
 * A `--since` / `--until` argument before it has been resolved against the
 * store. `last` needs a database lookup (the end of the most recent saved
 * digest window), so parsing and resolution are separate steps.
 */
export type TimeSpec =
  | { kind: 'last' }
  | { kind: 'instant'; at: string };

/**
 * Case-sensitive, deliberately.
 *
 * This was `/i`, which made `6M` mean six *minutes* — a plausible way to write
 * six months, silently answered with a six-minute window and "no threads moved".
 * Anything that looks like an offset but is not exactly one of these units is
 * now refused rather than guessed at.
 */
const RELATIVE = /^(\d+)\s*(m|h|d|w)$/;
const LOOKS_RELATIVE = /^(\d+)\s*([A-Za-z]+)$/;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Beyond this a Date is invalid; ECMAScript caps at ±100,000,000 days from the epoch. */
const MAX_TIME_MS = 8.64e15;

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
    const step = UNIT_MS[relative[2]!]!;
    if (amount === 0) {
      throw new ChymeError(`"${value}" is a zero-length window.`);
    }

    const at = now.getTime() - amount * step;
    // Guarded rather than left to throw: `new Date(-Infinity).toISOString()`
    // raises a bare RangeError, which the CLI would print as a stack trace and
    // the user would read as a bug in Chyme rather than a typo in their command.
    if (!Number.isFinite(at) || Math.abs(at) > MAX_TIME_MS) {
      throw new ChymeError(
        `"${value}" reaches further back than any date can express.`,
        'Try a smaller offset, or a date like 2020-01-01.',
      );
    }
    return { kind: 'instant', at: toIso(new Date(at)) };
  }

  const looksRelative = LOOKS_RELATIVE.exec(value);
  if (looksRelative) {
    const unit = looksRelative[2]!;
    throw new ChymeError(
      `"${value}" is not a time unit Chyme knows.`,
      unit === 'M' || unit === 'mo' || unit === 'y' || unit === 'Y'
        ? 'Units are m (minutes), h, d and w, lowercase. There is no month or year unit — say 90d, or give a date like 2026-01-01.'
        : 'Units are m (minutes), h (hours), d (days) and w (weeks), lowercase.',
    );
  }

  // A bare calendar date means the start of that day, UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new ChymeError(`"${value}" is not a real date.`);
    }
    return { kind: 'instant', at: toIso(parsed) };
  }

  // A timestamp with no zone is read as UTC, matching the bare-date case above.
  // `new Date()` would read it as local time, so the same command would mean
  // different instants on two machines and a bare date and a zoneless datetime
  // one second apart would land thirteen hours apart for a UTC+13 user.
  const zoneless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
  const parsed = new Date(zoneless ? `${value.replace(' ', 'T')}Z` : value);
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
