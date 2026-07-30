import { beforeEach, describe, expect, it } from 'vitest';
import type { ForgeEvent } from '../../domain/types.js';
import { openStore, type Store } from '../index.js';

function event(overrides: Partial<ForgeEvent> = {}): ForgeEvent {
  return {
    externalId: 'IC_1',
    kind: 'comment',
    actor: { externalId: 'U_bob', handle: 'bob', displayName: null, isBot: false },
    createdAt: '2026-07-02T10:00:00Z',
    body: 'This will melt under load.',
    path: null,
    line: null,
    detail: null,
    raw: { id: 'IC_1' },
    ...overrides,
  };
}

let store: Store;
let sourceId: number;
let threadId: number;
let projectId: number;

beforeEach(() => {
  store = openStore(':memory:');
  projectId = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now').id;
  sourceId = store.sources.upsertSource(
    { projectId, driver: 'github', key: 'acme/web', kinds: ['pull_request'] },
    'now',
  ).id;
  threadId = store.threads.upsertThread(
    sourceId,
    {
      externalId: 'PR_1',
      kind: 'pull_request',
      number: 42,
      title: 'Add a rate limiter',
      state: 'open',
      isDraft: false,
      author: null,
      url: 'https://example.test/42',
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-02T09:00:00Z',
      closedAt: null,
      mergedAt: null,
      labels: [],
      raw: null,
    },
    'now',
  ).id;
});

describe('upsertEvents', () => {
  it('dedupes on (thread, external_id) and takes the newer body', () => {
    const first = store.events.upsertEvents(threadId, sourceId, [event()]);
    const second = store.events.upsertEvents(threadId, sourceId, [
      event({ body: 'This will melt under load. (edited)' }),
    ]);

    expect(second[0]!.id).toBe(first[0]!.id);
    const stored = store.events.listEventsForThread(threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toBe('This will melt under load. (edited)');
  });

  it('keeps distinct external ids apart and orders by time', () => {
    store.events.upsertEvents(threadId, sourceId, [
      event({ externalId: 'IC_2', createdAt: '2026-07-03T10:00:00Z', body: 'second' }),
      event({ externalId: 'IC_1', createdAt: '2026-07-02T10:00:00Z', body: 'first' }),
    ]);

    expect(store.events.listEventsForThread(threadId).map((row) => row.body)).toEqual([
      'first',
      'second',
    ]);
    expect(store.events.countEventsForThread(threadId)).toBe(2);
  });

  it('stores inline review comment anchors and kind detail', () => {
    const [inline] = store.events.upsertEvents(threadId, sourceId, [
      event({
        externalId: 'PRRC_1',
        kind: 'review_comment',
        path: 'src/limiter.ts',
        line: 88,
        detail: { reviewState: 'CHANGES_REQUESTED' },
      }),
    ]);

    expect(inline!.path).toBe('src/limiter.ts');
    expect(inline!.line).toBe(88);
    expect(inline!.detail).toEqual({ reviewState: 'CHANGES_REQUESTED' });
    expect(store.events.getEventRaw(inline!.id)).toEqual({ id: 'IC_1' });
  });

  it('does not lose a known actor when a re-sync omits one', () => {
    const [withActor] = store.events.upsertEvents(threadId, sourceId, [event()]);
    const [withoutActor] = store.events.upsertEvents(threadId, sourceId, [event({ actor: null })]);

    expect(withoutActor!.actorId).toBe(withActor!.actorId);
    expect(withoutActor!.actorId).not.toBeNull();
  });

  it('is a no-op for an empty batch', () => {
    expect(store.events.upsertEvents(threadId, sourceId, [])).toEqual([]);
  });

  it('scopes a window query to the project', () => {
    store.events.upsertEvents(threadId, sourceId, [
      event({ externalId: 'a', createdAt: '2026-07-01T00:00:00Z' }),
      event({ externalId: 'b', createdAt: '2026-07-02T00:00:00Z' }),
      event({ externalId: 'c', createdAt: '2026-07-03T00:00:00Z' }),
    ]);

    const window = store.events.listEventsBetween(
      projectId,
      '2026-07-02T00:00:00Z',
      '2026-07-03T00:00:00Z',
    );

    expect(window.map((row) => row.externalId)).toEqual(['b']);
    expect(store.events.listEventsBetween(projectId + 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual([]);
  });

  it('deletes with its thread', () => {
    store.events.upsertEvents(threadId, sourceId, [event()]);
    store.threads.deleteThread(threadId);

    expect(store.events.countEventsForThread(threadId)).toBe(0);
  });
});
