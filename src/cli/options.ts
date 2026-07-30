import type { ThreadKind } from '../domain/types.js';
import { supportedThreadKinds } from '../drivers/registry.js';
import { ChymeError } from '../util/errors.js';
import { parseTimeSpec, type TimeSpec } from '../util/time.js';

/** Comma-separated CLI list, e.g. `--author kai,ren`. */
export function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function parseThreadKinds(value: string | undefined): ThreadKind[] | undefined {
  const items = splitList(value);
  if (!items) return undefined;

  // Validated against what the registered drivers actually offer, not a fixed
  // list: kinds are an open vocabulary and a new source type must not require
  // editing this file to be filterable.
  const known = supportedThreadKinds();
  const unknown = items.filter((item) => !known.includes(item));
  if (unknown.length > 0) {
    throw new ChymeError(
      `Unknown thread ${unknown.length === 1 ? 'kind' : 'kinds'}: ${unknown.join(', ')}`,
      `Available kinds: ${known.join(', ')}`,
    );
  }
  return items;
}

export function parseByteBudget(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new ChymeError(`--max-bytes must be a positive whole number, got "${value}".`);
  }
  return bytes;
}

export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ChymeError(`${flag} must be a positive whole number, got "${value}".`);
  }
  return parsed;
}

export function parseSince(value: string, now: Date): TimeSpec {
  return parseTimeSpec(value, now);
}

export function parseUntil(value: string | undefined, now: Date): TimeSpec | undefined {
  return value === undefined ? undefined : parseTimeSpec(value, now);
}

/** The two ends of a window are written `<since>..<until>`. */
const WINDOW_SEPARATOR = '..';

export interface WindowArgument {
  since: TimeSpec;
  until: TimeSpec;
}

/**
 * A whole window in one argument, exactly as `chyme activity` reports the
 * window it read.
 *
 * It exists so a window can be handed back rather than described again: an
 * `--until` that defaults to "now" is re-resolved at the moment of the second
 * command, and the minutes in between belong to no window at all.
 */
export function parseWindowArgument(value: string, now: Date): WindowArgument {
  const at = value.indexOf(WINDOW_SEPARATOR);
  const since = at === -1 ? '' : value.slice(0, at).trim();
  const until = at === -1 ? '' : value.slice(at + WINDOW_SEPARATOR.length).trim();
  if (since === '' || until === '') {
    throw new ChymeError(
      `--window must be <since>${WINDOW_SEPARATOR}<until>, got "${value}".`,
      '`chyme activity` prints the window it read in exactly that form.',
    );
  }
  return { since: parseTimeSpec(since, now), until: parseTimeSpec(until, now) };
}

/** How `activity` reports a window it resolved, and what `--window` accepts. */
export function formatWindowArgument(since: string, until: string): string {
  return `${since}${WINDOW_SEPARATOR}${until}`;
}
