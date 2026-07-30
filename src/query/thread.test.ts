import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { resolveThreadRef } from './refs.js';
import { queryThread } from './thread.js';

const ADA = actor('ada');
const KAI = actor('kai');

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api'] });
  fixture.addThread({
    number: 412,
    title: 'Add a rate limiter',
    createdAt: '2026-07-01T09:00:00Z',
    author: ADA,
    body: 'Token bucket in front of the ingest path.',
    labels: ['performance'],
    events: [
      { at: '2026-07-01T09:00:00Z', kind: 'state_change', by: ADA, body: null, detail: { transition: 'opened' } },
      { at: '2026-07-02T08:00:00Z', by: KAI, body: 'Refill looks too aggressive.' },
      { at: '2026-07-03T08:00:00Z', kind: 'commit', by: ADA, body: 'Slow the refill', detail: { sha: 'abcdef1234' } },
    ],
    files: [{ path: 'src/limiter.ts', additions: 120, patch: '@@ -0,0 +1 @@\n+export class Limiter {}' }],
  });
});

afterEach(() => fixture.close());

function view(options = {}) {
  return queryThread(fixture.store, resolveThreadRef(fixture.store, 'platform/acme/api#412'), options);
}

describe('queryThread', () => {
  it('returns the whole thread in order, with authorship', () => {
    const result = view();

    expect(result.ref).toBe('platform/acme/api#412');
    expect(result.author?.handle).toBe('ada');
    expect(result.events.map((entry) => entry.event.kind)).toEqual([
      'state_change',
      'comment',
      'commit',
    ]);
    expect(result.events[1]?.actor?.handle).toBe('kai');
    expect(result.totals).toEqual({
      events: 3,
      files: 1,
      additions: 120,
      deletions: 0,
      participants: 2,
    });
  });

  it('withholds diff hunks unless asked, and says nothing about them either way', () => {
    const without = view();
    expect(without.diffsIncluded).toBe(false);
    expect(without.files[0]?.patch).toBeNull();
    expect(without.files[0]?.additions).toBe(120);

    const with_ = view({ includeDiffs: true });
    expect(with_.diffsIncluded).toBe(true);
    expect(with_.files[0]?.patch).toContain('export class Limiter');
  });

  it('counts the events its options dropped', () => {
    const result = view({ includeCommits: false });

    expect(result.events.map((entry) => entry.event.kind)).toEqual(['state_change', 'comment']);
    expect(result.omittedEvents).toEqual({ commit: 1 });
    // The totals still describe the thread, not the view of it.
    expect(result.totals.events).toBe(3);
  });

  it('drops discussion but keeps the spine when comments are off', () => {
    const result = view({ includeComments: false });

    expect(result.events.map((entry) => entry.event.kind)).toEqual(['state_change', 'commit']);
    expect(result.omittedEvents).toEqual({ comment: 1 });
  });

  it('counts participants over the thread, not over the filtered view', () => {
    // Kai is only in the comment, so counting participants from the events that
    // survived the filter reported one participant beside a total of three
    // events — two numbers about different things, printed side by side.
    const result = view({ includeComments: false });

    expect(result.totals.events).toBe(3);
    expect(result.totals.participants).toBe(2);
    expect(result.totals.participants).toBe(view().totals.participants);
  });
});

describe('queryThread references', () => {
  it('resolves an outgoing edge to a reference the reader can open', () => {
    const other = fixture.addThread({ number: 88, createdAt: '2026-06-01T00:00:00Z' });
    const thread = resolveThreadRef(fixture.store, 'platform/acme/api#412').thread;

    const [reference] = fixture.store.references.replaceReferences(
      { kind: 'thread', id: thread.id },
      [
        { refKind: 'thread', refRaw: '#88', hint: { number: 88 } },
        { refKind: 'ticket', refRaw: 'PROJ-12', hint: null },
      ],
    );
    fixture.store.references.resolveReference(reference!.id, { kind: 'thread', id: other.id }, 1);

    const result = view();
    expect(result.referencesOut).toHaveLength(2);
    expect(result.referencesOut[0]?.target?.ref).toBe('platform/acme/api#88');
    expect(result.referencesOut[1]?.target).toBeNull();
    expect(result.referencesOut[1]?.reference.refRaw).toBe('PROJ-12');
  });

  it('answers "what points at this" for an edge that came from another thread\'s comment', () => {
    const thread = resolveThreadRef(fixture.store, 'platform/acme/api#412').thread;
    fixture.addThread({
      number: 500,
      createdAt: '2026-07-05T00:00:00Z',
      events: [{ at: '2026-07-05T01:00:00Z', by: KAI, body: 'Follow-up to #412.' }],
    });

    const pointing = fixture.store.threads.findThread(fixture.source('acme/api').id, 'pull_request', 500)!;
    const comment = fixture.store.events.listEventsForThread(pointing.id)[0]!;
    const [reference] = fixture.store.references.replaceReferences(
      { kind: 'event', id: comment.id },
      [{ refKind: 'thread', refRaw: '#412', hint: { number: 412 } }],
    );
    fixture.store.references.resolveReference(reference!.id, { kind: 'thread', id: thread.id }, 1);

    const [incoming] = view().referencesIn;
    expect(incoming?.from?.ref).toBe('platform/acme/api#500');
    expect(incoming?.fromEvent?.id).toBe(comment.id);
    expect(incoming?.fromActor?.handle).toBe('kai');
  });

  it('does not claim an edge from a comment it did not show', () => {
    const thread = resolveThreadRef(fixture.store, 'platform/acme/api#412').thread;
    const comment = fixture.store.events
      .listEventsForThread(thread.id)
      .find((event) => event.kind === 'comment')!;
    fixture.store.references.replaceReferences({ kind: 'event', id: comment.id }, [
      { refKind: 'ticket', refRaw: 'PROJ-99', hint: null },
    ]);

    expect(view().referencesOut.map((entry) => entry.reference.refRaw)).toEqual(['PROJ-99']);
    expect(view({ includeComments: false }).referencesOut).toEqual([]);
  });
});
