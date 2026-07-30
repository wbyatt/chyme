import { orderEventKinds, type EventKind, type KnownEventKind } from '../domain/types.js';
import type { ActorRow, ThreadRow } from '../store/index.js';
import { describeAge } from '../util/time.js';

/**
 * The small formatting decisions every renderer shares.
 *
 * Terse on purpose: this output is read by a model, so a field name that the
 * value already implies is pure cost. Nothing here invents a value — an absent
 * actor prints as "unknown", never as a plausible name.
 */

const EVENT_NOUNS: Record<KnownEventKind, [singular: string, plural: string]> = {
  comment: ['comment', 'comments'],
  review: ['review', 'reviews'],
  review_comment: ['inline comment', 'inline comments'],
  commit: ['commit', 'commits'],
  state_change: ['state change', 'state changes'],
  label: ['label change', 'label changes'],
  rename: ['rename', 'renames'],
};

/**
 * Event kinds are an open vocabulary, so a source may emit one this file has
 * never heard of. Print it under its own name rather than dropping it — an
 * unlabelled event is still evidence, and silence would misreport the thread.
 */
function nounsFor(kind: EventKind): [singular: string, plural: string] {
  const known = EVENT_NOUNS[kind as KnownEventKind];
  if (known) return known;
  const readable = kind.replace(/_/g, ' ');
  return [readable, `${readable}s`];
}

export function plural(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** A deleted account has no handle, and saying so beats standing in a ghost. */
export function handleOf(actor: ActorRow | null): string {
  return actor?.handle ?? 'unknown';
}

/** Bounded, because a thread with forty participants would bury its own title. */
export function handleList(actors: readonly ActorRow[], max = 8): string {
  const handles = actors.map((actor) => actor.handle);
  if (handles.length <= max) return handles.join(', ');
  return `${handles.slice(0, max).join(', ')} +${handles.length - max} more`;
}

/** Full instant plus its distance from now: one for precision, one for judgement. */
export function stamp(iso: string, now: Date): string {
  return `${iso} (${describeAge(iso, now)})`;
}

export function kindCounts(counts: Partial<Record<EventKind, number>>): string {
  const parts: string[] = [];
  for (const kind of orderEventKinds(Object.keys(counts))) {
    const count = counts[kind];
    if (!count) continue;
    const [singular, many] = nounsFor(kind);
    parts.push(plural(count, singular, many));
  }
  return parts.join(', ');
}

export function eventNoun(kind: EventKind, count: number): string {
  const [singular, many] = nounsFor(kind);
  return plural(count, singular, many);
}

export function diffstat(stat: { files: number; additions: number; deletions: number }): string {
  return `${plural(stat.files, 'file')} +${stat.additions} -${stat.deletions}`;
}

/** Draft is orthogonal to state, so both are shown rather than collapsed. */
export function threadStatus(thread: ThreadRow): string {
  return thread.isDraft ? `${thread.kind} ${thread.state} draft` : `${thread.kind} ${thread.state}`;
}

/** Read one field out of an event's `detail` without trusting its shape. */
export function detailText(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

export function detailFlag(detail: Record<string, unknown> | null, key: string): boolean {
  return detail?.[key] === true;
}
