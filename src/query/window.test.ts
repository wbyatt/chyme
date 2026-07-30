import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../testing/fixtures.js';
import { NotFoundError } from '../util/errors.js';
import { parseTimeSpec } from '../util/time.js';
import { resolveInstant, resolveWindow } from './window.js';

const NOW = new Date('2026-07-27T12:00:00Z');

let fixture: Fixture;

afterEach(() => fixture.close());

function open(): Fixture {
  fixture = createFixture();
  return fixture;
}

describe('resolveInstant', () => {
  it('passes an explicit instant through', () => {
    const f = open();
    expect(resolveInstant(f.store, f.project.id, parseTimeSpec('2026-07-01', NOW))).toEqual({
      at: '2026-07-01T00:00:00Z',
      origin: 'explicit',
      digestId: null,
    });
  });

  it('resolves "last" to the end of the most recent digest window', () => {
    const f = open();
    f.addDigest('2026-07-06T00:00:00Z', '2026-07-13T00:00:00Z');
    const newest = f.addDigest('2026-07-13T00:00:00Z', '2026-07-20T00:00:00Z');

    expect(resolveInstant(f.store, f.project.id, { kind: 'last' })).toEqual({
      at: '2026-07-20T00:00:00Z',
      origin: 'digest',
      digestId: newest.id,
    });
  });

  it('refuses to invent a window when no digest has been saved', () => {
    const f = open();
    // Silently defaulting to 7d would answer "what haven't I seen" with a guess,
    // and the reader has no way to tell.
    expect(() => resolveInstant(f.store, f.project.id, { kind: 'last' })).toThrow(NotFoundError);
    try {
      resolveInstant(f.store, f.project.id, { kind: 'last' });
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/--since/);
    }
  });
});

describe('resolveWindow', () => {
  it('ends at now by default', () => {
    const f = open();
    const window = resolveWindow(f.store, f.project.id, {
      since: parseTimeSpec('7d', NOW),
      now: NOW,
    });

    expect(window).toEqual({
      since: '2026-07-20T12:00:00Z',
      until: '2026-07-27T12:00:00Z',
      sinceOrigin: 'explicit',
      untilOrigin: 'now',
      digestId: null,
    });
  });

  it('carries the digest it resolved against', () => {
    const f = open();
    const digest = f.addDigest('2026-07-13T00:00:00Z', '2026-07-20T00:00:00Z');

    const window = resolveWindow(f.store, f.project.id, { since: { kind: 'last' }, now: NOW });

    expect(window.since).toBe('2026-07-20T00:00:00Z');
    expect(window.sinceOrigin).toBe('digest');
    expect(window.digestId).toBe(digest.id);
  });

  it('rejects a window with no time in it', () => {
    const f = open();
    expect(() =>
      resolveWindow(f.store, f.project.id, {
        since: parseTimeSpec('2026-07-20', NOW),
        until: parseTimeSpec('2026-07-10', NOW),
        now: NOW,
      }),
    ).toThrow(/contains no time/);
  });
});
