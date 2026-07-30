import { beforeEach, describe, expect, it } from 'vitest';
import type { ForgeActor } from '../../domain/types.js';
import { openStore, type Store } from '../index.js';
import type { ThreadInput } from './threads.js';

const ADA: ForgeActor = {
  externalId: 'U_ada',
  handle: 'ada',
  displayName: 'Ada Lovelace',
  isBot: false,
};

function threadInput(overrides: Partial<ThreadInput> = {}): ThreadInput {
  return {
    externalId: 'PR_kwDO1',
    kind: 'pull_request',
    number: 42,
    title: 'Add a rate limiter',
    state: 'open',
    isDraft: false,
    author: ADA,
    url: 'https://example.test/acme/web/pull/42',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-02T09:00:00Z',
    closedAt: null,
    mergedAt: null,
    labels: ['performance'],
    raw: { id: 'PR_kwDO1', extra: 'kept verbatim' },
    ...overrides,
  };
}

let store: Store;
let sourceId: number;

beforeEach(() => {
  store = openStore(':memory:');
  const project = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, '2026-07-01T00:00:00Z');
  sourceId = store.sources.upsertSource(
    { projectId: project.id, driver: 'github', key: 'acme/web', kinds: ['pull_request'] },
    '2026-07-01T00:00:00Z',
  ).id;
});

describe('upsertThread', () => {
  it('is idempotent on (source, kind, number)', () => {
    const first = store.threads.upsertThread(sourceId, threadInput(), '2026-07-02T12:00:00Z');
    const second = store.threads.upsertThread(sourceId, threadInput(), '2026-07-03T12:00:00Z');

    expect(second.id).toBe(first.id);
    expect(store.threads.listThreadsForSource(sourceId)).toHaveLength(1);
  });

  it('preserves first_seen_at while moving last_synced_at', () => {
    const first = store.threads.upsertThread(sourceId, threadInput(), '2026-07-02T12:00:00Z');
    expect(first.firstSeenAt).toBe('2026-07-02T12:00:00Z');

    const second = store.threads.upsertThread(
      sourceId,
      threadInput({ title: 'Add a rate limiter (v2)', state: 'merged', mergedAt: '2026-07-04T08:00:00Z' }),
      '2026-07-05T12:00:00Z',
    );

    expect(second.firstSeenAt).toBe('2026-07-02T12:00:00Z');
    expect(second.lastSyncedAt).toBe('2026-07-05T12:00:00Z');
    expect(second.title).toBe('Add a rate limiter (v2)');
    expect(second.state).toBe('merged');
    expect(second.mergedAt).toBe('2026-07-04T08:00:00Z');
  });

  it('keeps a stored body when the caller omits one', () => {
    store.threads.upsertThread(
      sourceId,
      threadInput({ body: 'The limiter is token-bucket based.' }),
      '2026-07-02T12:00:00Z',
    );

    const listingPass = store.threads.upsertThread(sourceId, threadInput(), '2026-07-03T12:00:00Z');

    expect(listingPass.body).toBe('The limiter is token-bucket based.');
  });

  it('clears the body when one is explicitly null', () => {
    store.threads.upsertThread(sourceId, threadInput({ body: 'gone soon' }), '2026-07-02T12:00:00Z');
    const cleared = store.threads.upsertThread(
      sourceId,
      threadInput({ body: null }),
      '2026-07-03T12:00:00Z',
    );

    expect(cleared.body).toBeNull();
  });

  it('reuses the author actor rather than creating a second one', () => {
    const first = store.threads.upsertThread(sourceId, threadInput(), '2026-07-02T12:00:00Z');
    const second = store.threads.upsertThread(
      sourceId,
      threadInput({ number: 43, externalId: 'PR_kwDO2', author: { ...ADA, handle: 'ada-renamed' } }),
      '2026-07-02T12:00:00Z',
    );

    expect(second.authorId).toBe(first.authorId);
    expect(store.actors.listActors(sourceId)).toHaveLength(1);
    // Renames follow the forge id, so history does not split when someone
    // changes their handle.
    expect(store.actors.getActor(first.authorId!)?.handle).toBe('ada-renamed');
  });

  it('round-trips labels and retains the driver payload verbatim', () => {
    const thread = store.threads.upsertThread(
      sourceId,
      threadInput({ labels: ['performance', 'needs-review'] }),
      '2026-07-02T12:00:00Z',
    );

    expect(thread.labels).toEqual(['performance', 'needs-review']);
    expect(store.threads.getThreadRaw(thread.id)).toEqual({
      id: 'PR_kwDO1',
      extra: 'kept verbatim',
    });
  });

  it('separates threads that share a number across kinds', () => {
    store.threads.upsertThread(sourceId, threadInput(), '2026-07-02T12:00:00Z');
    store.threads.upsertThread(
      sourceId,
      threadInput({ kind: 'issue', externalId: 'I_1' }),
      '2026-07-02T12:00:00Z',
    );

    expect(store.threads.listThreadsForSource(sourceId)).toHaveLength(2);
    expect(store.threads.findThread(sourceId, 'issue', 42)?.externalId).toBe('I_1');
  });
});

describe('listThreadsUpdatedBetween', () => {
  it('is half-open on the end of the window', () => {
    const projectId = store.projects.findProject('acme')!.id;
    store.threads.upsertThread(
      sourceId,
      threadInput({ number: 1, externalId: 'a', updatedAt: '2026-07-01T00:00:00Z' }),
      'now',
    );
    store.threads.upsertThread(
      sourceId,
      threadInput({ number: 2, externalId: 'b', updatedAt: '2026-07-02T00:00:00Z' }),
      'now',
    );
    store.threads.upsertThread(
      sourceId,
      threadInput({ number: 3, externalId: 'c', updatedAt: '2026-07-03T00:00:00Z' }),
      'now',
    );

    const window = store.threads.listThreadsUpdatedBetween(
      projectId,
      '2026-07-02T00:00:00Z',
      '2026-07-03T00:00:00Z',
    );

    expect(window.map((thread) => thread.number)).toEqual([2]);
    expect(store.threads.countThreads(projectId)).toBe(3);
  });
});
