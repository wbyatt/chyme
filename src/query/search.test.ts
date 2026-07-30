import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { querySearch } from './search.js';

const ADA = actor('ada');
const KAI = actor('kai');

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api', 'acme/worker'] });
  fixture.addThread({
    number: 412,
    title: 'Add a rate limiter',
    createdAt: '2026-07-01T09:00:00Z',
    author: ADA,
    body: 'Token bucket in front of the ingest path.',
    events: [{ at: '2026-07-02T08:00:00Z', by: KAI, body: 'The limiter refill is too aggressive.' }],
  });
  fixture.addThread({
    number: 9,
    source: 'acme/worker',
    title: 'Worker retries',
    createdAt: '2026-07-03T09:00:00Z',
    author: KAI,
    body: 'Nothing to do with throttling.',
    events: [],
  });
});

afterEach(() => fixture.close());

describe('querySearch', () => {
  it('resolves a hit to a reference that can be opened without a second lookup', () => {
    const results = querySearch(fixture.store, { text: 'limiter', project: fixture.project });

    expect(results.hits.length).toBeGreaterThan(0);
    for (const hit of results.hits) {
      expect(hit.ref).toBe('platform/acme/api#412');
      expect(hit.thread.title).toBe('Add a rate limiter');
      expect(hit.source.key).toBe('acme/api');
    }
  });

  it('names the writer of the matching text', () => {
    const results = querySearch(fixture.store, { text: 'aggressive', project: fixture.project });

    const [hit] = results.hits;
    expect(hit?.hit.entityKind).toBe('event');
    expect(hit?.event?.body).toContain('too aggressive');
    expect(hit?.actor?.handle).toBe('kai');
  });

  it('falls back to the thread author for a hit on the thread body', () => {
    const results = querySearch(fixture.store, { text: 'bucket', project: fixture.project });

    expect(results.hits[0]?.hit.entityKind).toBe('thread');
    expect(results.hits[0]?.event).toBeNull();
    expect(results.hits[0]?.actor?.handle).toBe('ada');
  });

  it("keeps the index's ranking", () => {
    const raw = fixture.store.search.search({
      text: 'limiter',
      projectId: fixture.project.id,
      limit: 50,
    });
    const results = querySearch(fixture.store, { text: 'limiter', project: fixture.project });

    expect(results.hits.map((hit) => hit.hit.entityId)).toEqual(raw.map((hit) => hit.entityId));
  });

  it('says when the result set was capped rather than implying it was complete', () => {
    const capped = querySearch(fixture.store, {
      text: 'limiter',
      project: fixture.project,
      limit: 1,
    });

    expect(capped.hits).toHaveLength(1);
    expect(capped.limited).toBe(true);
    expect(querySearch(fixture.store, { text: 'limiter', project: fixture.project }).limited).toBe(
      false,
    );
  });

  it('searches every project when none is named', () => {
    const results = querySearch(fixture.store, { text: 'retries' });
    expect(results.hits[0]?.ref).toBe('platform/acme/worker#9');
  });
});
