import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../testing/fixtures.js';
import { byteLength } from '../util/text.js';
import { renderDigest, renderDigestList } from './digest.js';

const NOW = new Date('2026-07-27T00:00:00Z');

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => fixture.close());

describe('renderDigestList', () => {
  it('lists the saved windows newest first', () => {
    fixture.addDigest('2026-07-06T00:00:00Z', '2026-07-13T00:00:00Z');
    fixture.addDigest('2026-07-13T00:00:00Z', '2026-07-20T00:00:00Z');

    const text = renderDigestList(
      fixture.project,
      fixture.store.digests.listDigests(fixture.project.id),
      { now: NOW },
    );

    expect(text).toContain('# platform digests — 2 saved');
    expect(text).toContain('2026-07-13T00:00:00Z → 2026-07-20T00:00:00Z');
    expect(text.indexOf('2026-07-20T00:00:00Z')).toBeLessThan(text.indexOf('2026-07-13T00:00:00Z  '));
  });

  it('explains an empty list rather than printing nothing', () => {
    const text = renderDigestList(fixture.project, [], { now: NOW });
    expect(text).toContain('`--since last` has nothing to measure from');
  });
});

describe('renderDigest', () => {
  it('reproduces the stored body under its window', () => {
    const digest = fixture.addDigest(
      '2026-07-13T00:00:00Z',
      '2026-07-20T00:00:00Z',
      '# Week two\n\nThe rate limiter argument continued.',
    );

    const text = renderDigest(fixture.project, digest, { now: NOW });

    expect(text).toContain(`# platform digest ${digest.id}`);
    expect(text).toContain('2026-07-13T00:00:00Z → 2026-07-20T00:00:00Z');
    expect(text).toContain('The rate limiter argument continued.');
  });

  it('marks a body it had to cut', () => {
    const digest = fixture.addDigest(
      '2026-07-13T00:00:00Z',
      '2026-07-20T00:00:00Z',
      'paragraph\n'.repeat(400),
    );

    const text = renderDigest(fixture.project, digest, { now: NOW, maxBytes: 600 });

    expect(byteLength(text)).toBeLessThanOrEqual(600);
    expect(text).toContain('omitted');
  });
});
