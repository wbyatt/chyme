import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryActivity, type ActivityFilters } from '../query/activity.js';
import type { ActivityWindow } from '../query/window.js';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { byteLength } from '../util/text.js';
import { renderActivity } from './activity.js';

const NOW = new Date('2026-07-27T00:00:00Z');

const WINDOW: ActivityWindow = {
  since: '2026-07-20T00:00:00Z',
  until: '2026-07-27T00:00:00Z',
  sinceOrigin: 'explicit',
  untilOrigin: 'now',
  digestId: null,
};

const ADA = actor('ada');
const KAI = actor('kai');
const BOT = actor('renovate[bot]', { bot: true });

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api', 'acme/worker'] });
});

afterEach(() => fixture.close());

function render(
  options: { maxBytes?: number; filters?: ActivityFilters; window?: ActivityWindow } = {},
): string {
  const result = queryActivity(
    fixture.store,
    fixture.project,
    options.window ?? WINDOW,
    options.filters ?? {},
  );
  return renderActivity(result, {
    now: NOW,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
}

/**
 * Two sources interleaved by recency: one busy repository and one thread in
 * another that is the second most recent of the lot. Grouping by source and
 * writing group by group would drop the second source entirely while showing
 * older threads from the first.
 */
function seedTwoSources(): void {
  fixture.addThread({
    number: 10,
    title: 'Thread number 10',
    createdAt: '2026-07-19T00:00:00Z',
    author: ADA,
    body: 'A description long enough that the one-line summary has something to say about it.',
    events: [{ at: '2026-07-26T01:00:00Z', by: KAI }],
  });
  for (let index = 1; index <= 9; index += 1) {
    fixture.addThread({
      number: index,
      title: `Thread number ${index}`,
      createdAt: '2026-07-19T00:00:00Z',
      author: ADA,
      body: 'A description long enough that the one-line summary has something to say about it.',
      events: [{ at: `2026-07-20T0${index}:00:00Z`, by: KAI }],
    });
  }
  fixture.addThread({
    number: 99,
    source: 'acme/worker',
    title: 'Worker retries',
    createdAt: '2026-07-19T00:00:00Z',
    author: ADA,
    body: 'A description long enough that the one-line summary has something to say about it.',
    events: [{ at: '2026-07-25T23:00:00Z', by: KAI }],
  });
}

function shownRefs(text: string): string[] {
  return [...text.matchAll(/(platform\/\S+#\d+) \[/g)].map((match) => match[1]!);
}

function seedThreads(count: number): void {
  for (let index = 1; index <= count; index += 1) {
    fixture.addThread({
      number: index,
      title: `Thread number ${index}`,
      createdAt: '2026-07-21T00:00:00Z',
      author: ADA,
      body: 'A description long enough that the one-line summary has something to say about it.',
      events: [{ at: `2026-07-2${index}T00:00:00Z`, by: KAI }],
    });
  }
}

describe('renderActivity', () => {
  it('heads the output with the window and the totals', () => {
    fixture.addThread({
      number: 412,
      title: 'Add a rate limiter',
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      labels: ['performance'],
      files: [{ path: 'src/limiter.ts', additions: 120, deletions: 3, patch: 'x'.repeat(200) }],
      events: [
        { at: '2026-07-22T08:00:00Z', by: KAI, body: 'Refill looks too aggressive.' },
        { at: '2026-07-23T08:00:00Z', kind: 'review', by: KAI, detail: { state: 'APPROVED' } },
      ],
    });

    const text = render();

    expect(text).toContain('# platform activity 2026-07-20T00:00:00Z → 2026-07-27T00:00:00Z');
    expect(text).toContain('1 thread (0 new, 1 ongoing)');
    expect(text).toContain('## acme/api');
    expect(text).toContain('platform/acme/api#412 [pull_request open] Add a rate limiter');
    expect(text).toContain('ongoing · by ada');
    expect(text).toContain('1 comment, 1 review');
    // ada opened it before the window and said nothing inside it, so she is the
    // author but not a participant in what moved.
    expect(text).toContain('with kai');
    expect(text).toContain('1 file +120 -3');
    expect(text).toContain('labels performance');
    expect(text).toMatch(/expand ~\d+ B \(diff \d+ B\)/);
  });

  it('says a digest is where the window came from', () => {
    seedThreads(1);
    const result = queryActivity(
      fixture.store,
      fixture.project,
      { ...WINDOW, sinceOrigin: 'digest', digestId: 4 },
      {},
    );
    expect(renderActivity(result, { now: NOW })).toContain('since your last saved digest');
  });

  it('renders an empty window as an answer, not an error', () => {
    const text = render({ window: { ...WINDOW, since: '2020-01-01T00:00:00Z', until: '2020-01-08T00:00:00Z' } });

    expect(text).toContain('No threads moved in this window.');
    expect(text).not.toContain('not shown');
  });

  it('keeps to a tight byte budget and says what it cut', () => {
    seedThreads(4);
    const text = render({ maxBytes: 800 });

    expect(byteLength(text)).toBeLessThanOrEqual(800);
    expect(text).toMatch(/\[\d+ of 4 threads not shown/);
    // Most recent first, so the newest thread is the one that survived.
    expect(text).toContain('platform/acme/api#4');
    expect(text).not.toContain('platform/acme/api#1 ');
  });

  it('never drops a thread without saying so', () => {
    seedThreads(4);
    for (const maxBytes of [200, 400, 600, 1000, 1600]) {
      const text = render({ maxBytes });
      expect(byteLength(text)).toBeLessThanOrEqual(maxBytes);
      const shown = [...text.matchAll(/platform\/acme\/api#\d+ \[/g)].length;
      if (shown < 4) expect(text).toMatch(/threads not shown/);
    }
  });

  it('drops the least recent threads, not the last source in the layout', () => {
    seedTwoSources();
    const result = queryActivity(fixture.store, fixture.project, WINDOW, {});
    const text = renderActivity(result, { now: NOW, maxBytes: 900 });

    const shown = shownRefs(text);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(result.threads.length);
    // Exactly the most recent N, whatever order the source grouping puts them
    // in — so "least recent first" describes what actually happened.
    expect([...shown].sort()).toEqual(
      result.threads
        .slice(0, shown.length)
        .map((activity) => activity.ref)
        .sort(),
    );
    expect(text).toContain('## acme/worker');
    expect(text).toContain('platform/acme/worker#99');
  });

  it('never lets a group heading claim more threads than it lists', () => {
    seedTwoSources();
    for (const maxBytes of [400, 700, 900, 1400, 2000, 4000, 8000]) {
      const text = render({ maxBytes });
      const sections = text.split(/^## /m).slice(1);

      for (const section of sections) {
        const heading = /^(\S+) — (?:(\d+) of )?(\d+) threads?/.exec(section);
        expect(heading, `budget ${maxBytes}: ${section.split('\n')[0]}`).not.toBeNull();
        const claimed = Number(heading![2] ?? heading![3]);
        expect(claimed, `budget ${maxBytes}: ${heading![0]}`).toBe(shownRefs(section).length);
      }
    }
  });

  it('names a source whose threads all fell to the budget', () => {
    seedTwoSources();
    const text = render({ maxBytes: 900 });

    // The worker thread outranks eight of the ten in acme/api, so at this
    // budget it is listed. Squeeze harder and the oldest source goes first.
    expect(text).toContain('## acme/worker');

    fixture.addThread({
      number: 1,
      source: 'acme/worker',
      title: 'Quiet worker change',
      createdAt: '2026-07-19T00:00:00Z',
      author: ADA,
      events: [{ at: '2026-07-20T00:30:00Z', by: KAI }],
    });
    const tight = render({ maxBytes: 700 });

    expect(shownRefs(tight).some((ref) => ref.includes('worker'))).toBe(false);
    expect(tight).toContain('[sources not listed: acme/worker (2 threads)]');
  });

  it('reports the threads its defaults kept out', () => {
    fixture.addThread({
      number: 9,
      createdAt: '2026-06-01T00:00:00Z',
      author: BOT,
      events: [{ at: '2026-07-22T00:00:00Z', by: BOT }],
    });
    seedThreads(1);

    expect(render()).toContain('[1 thread excluded: bot activity only]');
    expect(render({ filters: { authors: ['nobody'], includeBots: true } })).toContain(
      'moved but matched no filter',
    );
  });

  it('states the filters that were applied', () => {
    seedThreads(1);
    const text = render({ filters: { authors: ['kai'], paths: ['src/'], includeBots: true } });

    expect(text).toContain('filters: authors kai · paths src/ · bots included');
  });
});
