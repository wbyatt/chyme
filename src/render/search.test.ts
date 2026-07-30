import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { querySearch } from '../query/search.js';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { byteLength } from '../util/text.js';
import { renderSearch } from './search.js';

const ADA = actor('ada');
const KAI = actor('kai');

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api'] });
  for (const number of [1, 2, 3, 4]) {
    fixture.addThread({
      number,
      title: `Rate limiter part ${number}`,
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      body: 'The limiter refills a token bucket on a fixed schedule.',
      events: [
        { at: '2026-07-02T00:00:00Z', by: KAI, body: 'The limiter refill is too aggressive here.' },
      ],
    });
  }
});

afterEach(() => fixture.close());

function render(options: { limit?: number; maxBytes?: number } = {}): string {
  const results = querySearch(fixture.store, {
    text: 'limiter',
    project: fixture.project,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return renderSearch(results, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
}

describe('renderSearch', () => {
  it('gives every hit a reference and a snippet', () => {
    const text = render();

    expect(text).toMatch(/^# search "limiter" — \d+ hits/);
    expect(text).toContain('platform/acme/api#1 [pull_request open] Rate limiter part 1');
    expect(text).toContain('comment by kai 2026-07-02T00:00:00Z');
    expect(text).toContain('[limiter]');
  });

  it('says when the index capped the result set', () => {
    expect(render({ limit: 2 })).toContain('[capped at 2 hits; there may be more');
  });

  it('keeps to a tight budget and marks the hits it dropped', () => {
    const text = render({ maxBytes: 700 });

    expect(byteLength(text)).toBeLessThanOrEqual(700);
    expect(text).toMatch(/\[\d+ of \d+ hits not shown/);
  });

  it('renders no matches honestly', () => {
    const results = querySearch(fixture.store, {
      text: 'kubernetes',
      project: fixture.project,
    });
    const text = renderSearch(results);

    expect(text).toContain('Nothing in the store matches that.');
    expect(text).not.toContain('not shown');
  });
});
