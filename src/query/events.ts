import type { EventRow, Store } from '../store/index.js';

/**
 * Event lookup by id.
 *
 * The events repository lists by thread and by window but has no `getEvent`, and
 * two read paths need one: a search hit names an event id, and an incoming
 * reference edge points at an event whose thread is unknown. The id → thread_id
 * hop is the only thing here that reaches past a repository; the row itself
 * still comes from `listEventsForThread`, memoised because a result set and a
 * reference walk both return to the same threads repeatedly.
 */

export interface EventLookup {
  threadIdOf(eventId: number): number | null;
  find(eventId: number): EventRow | null;
}

export function createEventLookup(store: Store): EventLookup {
  const byThread = new Map<number, Map<number, EventRow>>();

  function eventsOf(threadId: number): Map<number, EventRow> {
    let events = byThread.get(threadId);
    if (!events) {
      events = new Map(store.events.listEventsForThread(threadId).map((row) => [row.id, row]));
      byThread.set(threadId, events);
    }
    return events;
  }

  function threadIdOf(eventId: number): number | null {
    const row = store.db.prepare('SELECT thread_id FROM event WHERE id = ?').get(eventId);
    const value = row?.['thread_id'];
    return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : null;
  }

  return {
    threadIdOf,
    find(eventId) {
      const threadId = threadIdOf(eventId);
      return threadId === null ? null : (eventsOf(threadId).get(eventId) ?? null);
    },
  };
}
