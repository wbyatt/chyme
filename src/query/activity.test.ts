import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { queryActivity, type ActivityFilters } from './activity.js';
import type { ActivityWindow } from './window.js';

const WINDOW: ActivityWindow = {
  since: '2026-07-20T00:00:00Z',
  until: '2026-07-27T00:00:00Z',
  sinceOrigin: 'explicit',
  untilOrigin: 'explicit',
  digestId: null,
};

const ADA = actor('ada');
const BOB = actor('bob');
const KAI = actor('kai');
const BOT = actor('dependabot[bot]', { bot: true });

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api', 'acme/worker'] });
});

afterEach(() => fixture.close());

function run(filters: ActivityFilters = {}, window = WINDOW) {
  return queryActivity(fixture.store, fixture.project, window, filters);
}

function refs(filters: ActivityFilters = {}): string[] {
  return run(filters).threads.map((thread) => thread.ref);
}

describe('queryActivity', () => {
  it('enumerates a thread whose source timestamp has moved past the window', () => {
    // The case enumeration by `updated_at` alone gets wrong: the thread was
    // commented on inside the window and touched again after it.
    fixture.addThread({
      number: 1,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-28T00:00:00Z',
      events: [{ at: '2026-07-22T09:00:00Z', by: BOB }],
    });

    expect(refs()).toEqual(['platform/acme/api#1']);
  });

  it('separates threads created inside the window from ones that only moved in it', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      events: [{ at: '2026-07-22T09:00:00Z', by: BOB }],
    });
    fixture.addThread({
      number: 2,
      createdAt: '2026-07-21T00:00:00Z',
      events: [{ at: '2026-07-21T00:00:00Z', kind: 'state_change', by: ADA, body: null }],
    });

    const result = run();
    const byRef = new Map(result.threads.map((thread) => [thread.ref, thread]));

    expect(byRef.get('platform/acme/api#1')?.disposition).toBe('ongoing');
    expect(byRef.get('platform/acme/api#2')?.disposition).toBe('new');
    expect(result.totals.newThreads).toBe(1);
    expect(result.totals.ongoingThreads).toBe(1);
  });

  it('ignores threads whose only activity is outside the window', () => {
    fixture.addThread({
      number: 3,
      createdAt: '2026-06-01T00:00:00Z',
      events: [{ at: '2026-07-10T00:00:00Z', by: BOB }],
    });

    const result = run();
    expect(result.threads).toEqual([]);
    expect(result.totals.threads).toBe(0);
    expect(result.excluded).toEqual({ byFilter: 0, botOnly: 0 });
  });

  it('sorts by most recent activity first', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      events: [{ at: '2026-07-21T00:00:00Z', by: BOB }],
    });
    fixture.addThread({
      number: 2,
      createdAt: '2026-06-01T00:00:00Z',
      events: [{ at: '2026-07-25T00:00:00Z', by: BOB }],
    });
    fixture.addThread({
      number: 3,
      createdAt: '2026-06-01T00:00:00Z',
      events: [{ at: '2026-07-23T00:00:00Z', by: BOB }],
    });

    expect(refs()).toEqual([
      'platform/acme/api#2',
      'platform/acme/api#3',
      'platform/acme/api#1',
    ]);
  });

  it('counts events by kind and collects participants', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      author: ADA,
      events: [
        { at: '2026-07-21T00:00:00Z', by: BOB },
        { at: '2026-07-22T00:00:00Z', kind: 'review', by: KAI, detail: { state: 'APPROVED' } },
        { at: '2026-07-23T00:00:00Z', kind: 'commit', by: ADA },
        { at: '2026-07-10T00:00:00Z', by: KAI },
      ],
    });

    const [thread] = run().threads;
    expect(thread?.eventCounts).toEqual({ comment: 1, review: 1, commit: 1 });
    // The pre-window comment is not in the window, but its author is not a
    // participant on that basis alone.
    expect(thread?.participants.map((person) => person.handle)).toEqual(['ada', 'bob', 'kai']);
    expect(thread?.lastActivityAt).toBe('2026-07-23T00:00:00Z');
  });

  it('estimates what an expansion would cost', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-07-21T00:00:00Z',
      body: 'x'.repeat(500),
      events: [{ at: '2026-07-22T00:00:00Z', by: BOB, body: 'y'.repeat(1000) }],
      files: [{ path: 'src/limiter.ts', patch: 'z'.repeat(2000) }],
    });

    const [thread] = run().threads;
    expect(thread?.size.discussionBytes).toBeGreaterThan(1500);
    expect(thread?.size.diffBytes).toBeGreaterThan(2000);
    expect(thread?.size.totalBytes).toBe(
      (thread?.size.discussionBytes ?? 0) + (thread?.size.diffBytes ?? 0),
    );
    expect(thread?.diffstat).toEqual({ files: 1, additions: 1, deletions: 0 });
  });
});

describe('queryActivity filters', () => {
  beforeEach(() => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      author: ADA,
      files: [{ path: 'src/billing/rates.ts' }],
      events: [{ at: '2026-07-21T00:00:00Z', by: BOB }],
    });
    fixture.addThread({
      number: 2,
      kind: 'issue',
      createdAt: '2026-07-21T00:00:00Z',
      author: KAI,
      events: [{ at: '2026-07-22T00:00:00Z', by: KAI }],
    });
    fixture.addThread({
      number: 3,
      source: 'acme/worker',
      createdAt: '2026-07-22T00:00:00Z',
      author: ADA,
      files: [{ path: 'worker/main.ts' }],
      events: [{ at: '2026-07-22T00:00:00Z', by: ADA }],
    });
  });

  it('matches an author as the opener or as a voice in the window', () => {
    expect(refs({ authors: ['kai'] })).toEqual(['platform/acme/api#2']);
    // bob opened nothing; he commented on #1.
    expect(refs({ authors: ['BOB'] })).toEqual(['platform/acme/api#1']);
  });

  it('matches a path prefix against the changed files', () => {
    expect(refs({ paths: ['src/billing'] })).toEqual(['platform/acme/api#1']);
    expect(run({ paths: ['src/billing'] }).excluded.byFilter).toBe(2);
  });

  it('matches an inline comment path too', () => {
    fixture.addThread({
      number: 4,
      createdAt: '2026-06-01T00:00:00Z',
      events: [
        {
          at: '2026-07-23T00:00:00Z',
          kind: 'review_comment',
          by: KAI,
          path: 'docs/limits.md',
          line: 3,
        },
      ],
    });

    expect(refs({ paths: ['docs/'] })).toEqual(['platform/acme/api#4']);
  });

  it('filters by source key and by thread kind', () => {
    expect(refs({ sourceKeys: ['acme/worker'] })).toEqual(['platform/acme/worker#3']);
    expect(refs({ kinds: ['issue'] })).toEqual(['platform/acme/api#2']);
  });
});

describe('queryActivity and bots', () => {
  it('does not let a bot pull a thread in, and says how many it kept out', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      author: ADA,
      events: [{ at: '2026-07-22T00:00:00Z', by: BOT }],
    });

    const result = run();
    expect(result.threads).toEqual([]);
    expect(result.excluded.botOnly).toBe(1);

    expect(refs({ includeBots: true })).toEqual(['platform/acme/api#1']);
  });

  it('still shows bot events on a thread a human moved', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-06-01T00:00:00Z',
      author: ADA,
      events: [
        { at: '2026-07-22T00:00:00Z', by: BOT },
        { at: '2026-07-23T00:00:00Z', by: BOB },
      ],
    });

    const [thread] = run().threads;
    expect(thread?.events).toHaveLength(2);
    expect(thread?.participants.map((person) => person.handle)).toEqual([
      'bob',
      'dependabot[bot]',
    ]);
  });

  it('keeps a thread a bot opened when a human replies', () => {
    fixture.addThread({
      number: 1,
      createdAt: '2026-07-21T00:00:00Z',
      author: BOT,
      events: [
        { at: '2026-07-21T00:00:00Z', kind: 'state_change', by: BOT, body: null },
        { at: '2026-07-22T00:00:00Z', by: KAI },
      ],
    });

    expect(refs()).toEqual(['platform/acme/api#1']);
  });
});
