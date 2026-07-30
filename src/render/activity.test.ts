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
