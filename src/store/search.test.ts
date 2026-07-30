import { beforeEach, describe, expect, it } from 'vitest';
import { ChymeError } from '../util/errors.js';
import { openStore, type Store } from './index.js';
import { toMatchExpression, type IndexedEvent, type IndexedThread } from './search.js';

const THREAD: IndexedThread = {
  threadId: 1,
  projectId: 10,
  title: 'Add a rate limiter to the ingest path',
  body: 'Token bucket, sized from the p99 burst we saw in June.',
  createdAt: '2026-07-01T09:00:00Z',
};

const EVENTS: IndexedEvent[] = [
  { eventId: 100, body: 'The bucket refill is too aggressive under load.', createdAt: '2026-07-02T10:00:00Z' },
  { eventId: 101, body: null, createdAt: '2026-07-02T11:00:00Z' },
  { eventId: 102, body: '   ', createdAt: '2026-07-02T12:00:00Z' },
];

let store: Store;

beforeEach(() => {
  store = openStore(':memory:');
  store.search.indexThread(THREAD, EVENTS);
});

describe('search', () => {
  it('finds a thread by its title', () => {
    const [hit] = store.search.search({ text: 'ingest' });

    expect(hit).toBeDefined();
    expect(hit!.entityKind).toBe('thread');
    expect(hit!.entityId).toBe(1);
    expect(hit!.threadId).toBe(1);
    expect(hit!.projectId).toBe(10);
    expect(hit!.snippet).toContain('[ingest]');
  });

  it('finds a thread by its body', () => {
    const hits = store.search.search({ text: 'p99' });
    expect(hits.map((hit) => hit.entityId)).toEqual([1]);
  });

  it('finds an event by its body', () => {
    const hits = store.search.search({ text: 'aggressive' });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.entityKind).toBe('event');
    expect(hits[0]!.entityId).toBe(100);
    expect(hits[0]!.createdAt).toBe('2026-07-02T10:00:00Z');
  });

  it('skips events with no prose', () => {
    expect(
      store.db.prepare("SELECT count(*) AS n FROM search_index WHERE entity_kind = 'event'").get()?.n,
    ).toBe(1);
  });

  it('ANDs terms and matches phrases', () => {
    expect(store.search.search({ text: 'bucket refill' }).map((hit) => hit.entityId)).toEqual([100]);
    expect(store.search.search({ text: '"token bucket"' }).map((hit) => hit.entityId)).toEqual([1]);
    expect(store.search.search({ text: '"bucket token"' })).toEqual([]);
    expect(store.search.search({ text: 'limi*' }).map((hit) => hit.entityId)).toEqual([1]);
  });

  it('does not accumulate duplicates when a thread is re-indexed', () => {
    store.search.indexThread({ ...THREAD, title: 'Add a rate limiter to the ingest path (v2)' }, EVENTS);
    store.search.indexThread({ ...THREAD, title: 'Add a rate limiter to the ingest path (v2)' }, EVENTS);

    expect(store.search.search({ text: 'ingest' })).toHaveLength(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM search_index').get()?.n).toBe(2);
  });

  it('drops text that an edit removed', () => {
    store.search.indexThread({ ...THREAD, body: 'Rewritten with no numbers.' }, []);

    expect(store.search.search({ text: 'p99' })).toEqual([]);
    expect(store.search.search({ text: 'aggressive' })).toEqual([]);
    expect(store.search.search({ text: 'rewritten' })).toHaveLength(1);
  });

  it('removes a thread entirely', () => {
    store.search.removeThread(1);

    expect(store.search.search({ text: 'ingest' })).toEqual([]);
    expect(store.db.prepare('SELECT count(*) AS n FROM search_index').get()?.n).toBe(0);
  });

  it('filters by project, thread, kind and window', () => {
    store.search.indexThread(
      { threadId: 2, projectId: 20, title: 'Unrelated ingest work', body: null, createdAt: '2026-07-05T09:00:00Z' },
      [],
    );

    expect(store.search.search({ text: 'ingest', projectId: 10 }).map((hit) => hit.threadId)).toEqual([1]);
    expect(store.search.search({ text: 'ingest', threadId: 2 }).map((hit) => hit.threadId)).toEqual([2]);
    expect(store.search.search({ text: 'bucket', kinds: ['thread'] }).map((hit) => hit.entityId)).toEqual([1]);
    expect(
      store.search.search({ text: 'ingest', since: '2026-07-02T00:00:00Z' }).map((hit) => hit.threadId),
    ).toEqual([2]);
    expect(
      store.search.search({ text: 'ingest', until: '2026-07-02T00:00:00Z' }).map((hit) => hit.threadId),
    ).toEqual([1]);
  });

  it('honours the limit', () => {
    expect(store.search.search({ text: 'bucket', limit: 1 })).toHaveLength(1);
  });

  it('scores higher for better matches', () => {
    const hits = store.search.search({ text: 'bucket' });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });
});

describe('malformed queries', () => {
  const bad = ['"unclosed', '*', '   ', '', '- -', '**'];

  for (const text of bad) {
    it(`rejects ${JSON.stringify(text)} with a Chyme error`, () => {
      let thrown: unknown;
      try {
        store.search.search({ text });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ChymeError);
      expect((thrown as ChymeError).hint).toBeTruthy();
      // Never a bare SQLite message.
      expect((thrown as Error).message).not.toMatch(/fts5|syntax error near/i);
    });
  }

  it('treats FTS5 operators as literal words rather than syntax', () => {
    for (const text of ['bucket AND refill', 'NEAR(bucket refill)', 'body:bucket', 'a OR', '^bucket', 'bucket -refill']) {
      expect(() => store.search.search({ text })).not.toThrow();
    }
  });

  it('survives a quote inside a phrase', () => {
    store.search.indexThread(
      { threadId: 3, projectId: 10, title: 'He said "ship it" anyway', body: null, createdAt: '2026-07-06T09:00:00Z' },
      [],
    );

    expect(store.search.search({ text: '"ship it"' }).map((hit) => hit.threadId)).toEqual([3]);
  });
});

describe('toMatchExpression', () => {
  it('quotes every term so nothing is FTS5 syntax', () => {
    expect(toMatchExpression('rate limiter')).toBe('"rate" "limiter"');
    expect(toMatchExpression('"rate limiter"')).toBe('"rate limiter"');
    expect(toMatchExpression('limi*')).toBe('"limi"*');
    expect(toMatchExpression('a AND b')).toBe('"a" "AND" "b"');
    expect(toMatchExpression('col:value')).toBe('"col:value"');
  });

  it('escapes an embedded quote', () => {
    expect(toMatchExpression('say "hi" now')).toBe('"say" "hi" "now"');
  });
});
