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
