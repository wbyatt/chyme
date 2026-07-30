import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../testing/fixtures.js';
import { NotFoundError } from '../util/errors.js';
import { formatThreadRef, parseThreadRef, resolveThreadRef } from './refs.js';

let fixture: Fixture | null = null;

function open(sources: readonly string[] = ['acme/api']): Fixture {
  fixture = createFixture({ sources });
  return fixture;
}

afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('parseThreadRef', () => {
  it('round-trips a formatted reference', () => {
    for (const [slug, key, number] of [
      ['platform', 'acme/api', 412],
      ['p', 'a/b/c', 1],
      // A key with a # in it still round-trips, because the number is split off
      // from the right.
      ['platform', 'acme/api#main', 9],
    ] as const) {
      expect(parseThreadRef(formatThreadRef(slug, key, number))).toEqual({
        projectSlug: slug,
        sourceKey: key,
        number,
      });
    }
  });

  it('accepts a bare number with or without the hash', () => {
    expect(parseThreadRef('#412')).toEqual({ projectSlug: null, sourceKey: null, number: 412 });
    expect(parseThreadRef(' 412 ')).toEqual({ projectSlug: null, sourceKey: null, number: 412 });
  });

  it('accepts a project without a source', () => {
    expect(parseThreadRef('platform#7')).toEqual({
      projectSlug: 'platform',
      sourceKey: null,
      number: 7,
    });
  });

  it('rejects anything that is not a reference', () => {
    expect(() => parseThreadRef('')).toThrow(/Empty/);
    expect(() => parseThreadRef('platform/acme/api')).toThrow(/not a thread reference/);
    expect(() => parseThreadRef('platform/acme/api#abc')).toThrow(/not a thread reference/);
    expect(() => parseThreadRef('#0')).toThrow(/start at 1/);
  });
});

describe('resolveThreadRef', () => {
  it('resolves a fully qualified reference', () => {
    const f = open();
    f.addThread({ number: 412, createdAt: '2026-07-01T00:00:00Z' });

    const resolved = resolveThreadRef(f.store, 'platform/acme/api#412');

    expect(resolved.ref).toBe('platform/acme/api#412');
    expect(resolved.thread.number).toBe(412);
    expect(resolved.source.key).toBe('acme/api');
    expect(resolved.project.slug).toBe('platform');
  });

  it('resolves a bare number inside a project with one source', () => {
    const f = open();
    f.addThread({ number: 412, createdAt: '2026-07-01T00:00:00Z' });

    expect(resolveThreadRef(f.store, '#412', { projectSlug: 'platform' }).ref).toBe(
      'platform/acme/api#412',
    );
  });

  it('errors with the candidates when a bare number is ambiguous', () => {
    const f = open(['acme/api', 'acme/worker']);
    f.addThread({ number: 7, createdAt: '2026-07-01T00:00:00Z' });
    f.addThread({ number: 7, source: 'acme/worker', createdAt: '2026-07-01T00:00:00Z' });

    expect(() => resolveThreadRef(f.store, '#7', { projectSlug: 'platform' })).toThrow(
      /matches 2 threads/,
    );
    try {
      resolveThreadRef(f.store, '#7', { projectSlug: 'platform' });
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('platform/acme/api#7');
      expect((error as { hint?: string }).hint).toContain('platform/acme/worker#7');
    }
  });

  it('separates an issue from a pull request with the same number', () => {
    const f = open();
    f.addThread({ number: 7, createdAt: '2026-07-01T00:00:00Z' });
    f.addThread({ number: 7, kind: 'issue', createdAt: '2026-07-01T00:00:00Z' });

    expect(() => resolveThreadRef(f.store, 'platform/acme/api#7')).toThrow(/matches 2 threads/);
    expect(
      resolveThreadRef(f.store, 'platform/acme/api#7', { kind: 'issue' }).thread.kind,
    ).toBe('issue');
  });

  it('reads a leading source key as one when it names no project', () => {
    const f = open();
    f.addThread({ number: 412, createdAt: '2026-07-01T00:00:00Z' });

    expect(resolveThreadRef(f.store, 'acme/api#412', { projectSlug: 'platform' }).ref).toBe(
      'platform/acme/api#412',
    );
  });

  it('says which project it does not know', () => {
    const f = open();
    expect(() => resolveThreadRef(f.store, 'nope/acme/api#1')).toThrow(NotFoundError);
  });

  it('refuses to guess a project for a bare number', () => {
    const f = open();
    expect(() => resolveThreadRef(f.store, '#412')).toThrow(/does not say which project/);
  });

  it('reports an unknown source with the ones the project has', () => {
    const f = open();
    try {
      resolveThreadRef(f.store, 'platform/acme/nope#1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as { hint?: string }).hint).toContain('acme/api');
    }
  });

  it('reports a missing thread rather than an empty result', () => {
    const f = open();
    expect(() => resolveThreadRef(f.store, 'platform/acme/api#999')).toThrow(NotFoundError);
  });

  it('still resolves a kind the config has since stopped asking for', () => {
    const f = open();
    f.addThread({ number: 41, kind: 'issue', createdAt: '2026-07-01T00:00:00Z' });

    // What `upsertSource` does when a user narrows `kinds` in their config: the
    // declaration changes, the already-synced issue stays, and `activity` goes
    // on printing its reference.
    f.store.sources.upsertSource(
      { projectId: f.project.id, driver: 'github', key: 'acme/api', kinds: ['pull_request'] },
      '2026-07-02T00:00:00Z',
    );

    expect(resolveThreadRef(f.store, 'platform/acme/api#41').thread.kind).toBe('issue');
  });

  it('resolves a kind no driver in this build has heard of', () => {
    const f = open();
    f.addSource('acme/tickets', ['ticket']);
    f.addThread({ number: 88, source: 'acme/tickets', kind: 'ticket', createdAt: '2026-07-01T00:00:00Z' });

    expect(resolveThreadRef(f.store, 'platform/acme/tickets#88').thread.kind).toBe('ticket');
  });
});

/**
 * `chyme project add acme` next to a project that follows `acme/api` is an
 * ordinary setup, and it makes `acme/api#412` mean two things at once.
 */
describe('resolveThreadRef when a project is named after a source owner', () => {
  /** A second project `acme` whose one source is keyed `api`. */
  function addAcmeProject(f: Fixture): (number: number) => void {
    const project = f.store.projects.upsertProject(
      { slug: 'acme', name: 'Acme' },
      '2026-01-01T00:00:00Z',
    );
    const source = f.store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key: 'api', kinds: ['pull_request'] },
      '2026-01-01T00:00:00Z',
    );

    return (number) => {
      f.store.threads.upsertThread(
        source.id,
        {
          externalId: `pr_api_${number}`,
          kind: 'pull_request',
          number,
          title: `Thread ${number} in the acme project`,
          state: 'open',
          isDraft: false,
          author: null,
          url: `https://example.test/api/pull/${number}`,
          body: null,
          createdAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
          closedAt: null,
          mergedAt: null,
          labels: [],
          raw: null,
        },
        '2026-07-01T00:00:00Z',
      );
    };
  }

  it('falls back to the source-key reading when the project reading finds nothing', () => {
    const f = open();
    addAcmeProject(f);
    f.addThread({ number: 412, createdAt: '2026-07-01T00:00:00Z' });

    // Project "acme" and its source "api" are both real; the thread is not.
    // Committing to that reading refused a reference that plainly resolves.
    expect(resolveThreadRef(f.store, 'acme/api#412', { projectSlug: 'platform' }).ref).toBe(
      'platform/acme/api#412',
    );
  });

  it('keeps the project reading when only that one resolves', () => {
    const f = open();
    addAcmeProject(f)(7);

    expect(resolveThreadRef(f.store, 'acme/api#7', { projectSlug: 'platform' }).ref).toBe(
      'acme/api#7',
    );
  });

  it('errors with both candidates when each reading names a real thread', () => {
    const f = open();
    addAcmeProject(f)(412);
    f.addThread({ number: 412, createdAt: '2026-07-01T00:00:00Z' });

    try {
      resolveThreadRef(f.store, 'acme/api#412', { projectSlug: 'platform' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/matches 2 threads/);
      const hint = (error as { hint?: string }).hint ?? '';
      expect(hint).toContain('acme/api#412');
      expect(hint).toContain('platform/acme/api#412');
    }
  });
});
