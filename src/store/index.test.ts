import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceEvent, ThreadDetail } from '../domain/types.js';
import { openStore, type Store } from './index.js';
import { LATEST_VERSION } from './migrations.js';

const directories: string[] = [];

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chyme-store-'));
  directories.push(directory);
  // A directory that does not exist yet: opening must create it.
  return join(directory, 'data', 'chyme.db');
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

const DETAIL: ThreadDetail = {
  externalId: 'PR_1',
  kind: 'pull_request',
  number: 42,
  title: 'Add a rate limiter',
  state: 'open',
  isDraft: false,
  author: { externalId: 'U_ada', handle: 'ada', displayName: 'Ada', isBot: false },
  url: 'https://example.test/acme/web/pull/42',
  body: 'Token bucket in front of the ingest path.',
  createdAt: '2026-07-01T09:00:00Z',
  updatedAt: '2026-07-02T09:00:00Z',
  closedAt: null,
  mergedAt: null,
  labels: ['performance'],
  raw: { id: 'PR_1' },
  events: [
    {
      externalId: 'IC_1',
      kind: 'comment',
      actor: { externalId: 'U_bob', handle: 'bob', displayName: null, isBot: false },
      createdAt: '2026-07-02T08:00:00Z',
      body: 'Refill looks too aggressive.',
      path: null,
      line: null,
      detail: null,
      raw: {},
    } satisfies SourceEvent,
  ],
  files: [
    {
      path: 'src/limiter.ts',
      previousPath: null,
      status: 'added',
      additions: 120,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+export class Limiter {}\n',
      patchTruncated: false,
    },
  ],
};

/** The write path one sync of one thread performs, end to end. */
function ingest(store: Store, path: string): void {
  store.transaction(() => {
    const project = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now');
    const source = store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key: path, kinds: ['pull_request'] },
      'now',
    );
    const thread = store.threads.upsertThread(source.id, DETAIL, '2026-07-02T12:00:00Z');
    const events = store.events.upsertEvents(thread.id, source.id, DETAIL.events);
    store.fileChanges.replaceFileChanges(thread.id, DETAIL.files);
    store.references.replaceReferences({ kind: 'thread', id: thread.id }, [
      { refKind: 'thread', refRaw: '#88', hint: { number: 88 } },
    ]);
    store.search.indexThread(
      {
        threadId: thread.id,
        projectId: project.id,
        title: thread.title,
        body: thread.body,
        createdAt: thread.createdAt,
      },
      events.map((event) => ({ eventId: event.id, body: event.body, createdAt: event.createdAt })),
    );
    store.cursors.advanceCursor(source.id, 'pull_request', thread.updatedAt, 'now');
  });
}

describe('openStore', () => {
  it('creates the database file and its parent directory, and migrates it', () => {
    const path = tempDatabase();
    const store = openStore(path);

    expect(existsSync(path)).toBe(true);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(LATEST_VERSION);
    store.close();
  });

  it('survives a full ingest and reopen', () => {
    const path = tempDatabase();

    const first = openStore(path);
    ingest(first, 'acme/web');
    first.close();

    const second = openStore(path);
    const project = second.projects.requireProject('acme');
    const source = second.sources.findSource(project.id, 'github', 'acme/web')!;
    const thread = second.threads.findThread(source.id, 'pull_request', 42)!;

    expect(thread.title).toBe('Add a rate limiter');
    expect(second.events.listEventsForThread(thread.id)).toHaveLength(1);
    expect(second.fileChanges.listFileChanges(thread.id)).toHaveLength(1);
    expect(second.references.listReferencesFrom({ kind: 'thread', id: thread.id })).toHaveLength(1);
    expect(second.cursors.getCursorValue(source.id, 'pull_request')).toBe('2026-07-02T09:00:00Z');
    expect(second.search.search({ text: 'aggressive' })).toHaveLength(1);
    second.close();
  });

  it('re-ingesting the same thread changes nothing', () => {
    const store = openStore(':memory:');
    ingest(store, 'acme/web');
    ingest(store, 'acme/web');

    const counts = (table: string): number =>
      Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);

    expect(counts('project')).toBe(1);
    expect(counts('source')).toBe(1);
    expect(counts('thread')).toBe(1);
    expect(counts('event')).toBe(1);
    expect(counts('file_change')).toBe(1);
    expect(counts('reference')).toBe(1);
    expect(counts('search_index')).toBe(2);
    expect(counts('actor')).toBe(2);
    store.close();
  });

  it('leaves nothing behind when a source the config dropped is removed', () => {
    const store = openStore(':memory:');
    ingest(store, 'acme/web');

    const project = store.projects.requireProject('acme');
    const source = store.sources.findSource(project.id, 'github', 'acme/web')!;
    const thread = store.threads.findThread(source.id, 'pull_request', 42)!;

    store.sources.deleteSource(source.id);

    // Threads and events go by foreign key; the search index and the
    // polymorphic reference edges go by trigger, which is the only reason a
    // cascade this far from either table cleans them up.
    expect(store.threads.getThread(thread.id)).toBeNull();
    expect(store.db.prepare('SELECT count(*) AS n FROM search_index').get()?.n).toBe(0);
    expect(store.references.listReferencesFrom({ kind: 'thread', id: thread.id })).toEqual([]);
    store.close();
  });

  it('rolls a failed transaction back across repositories', () => {
    const store = openStore(':memory:');

    expect(() =>
      store.transaction(() => {
        store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now');
        throw new Error('driver blew up half way through');
      }),
    ).toThrow('driver blew up half way through');

    expect(store.projects.listProjects()).toEqual([]);
    store.close();
  });

  it('nests transactions without a second BEGIN', () => {
    const store = openStore(':memory:');

    store.transaction(() => {
      store.projects.upsertProject({ slug: 'outer', name: 'Outer' }, 'now');
      // replaceFileChanges opens its own transaction internally.
      expect(() =>
        store.transaction(() => {
          store.projects.upsertProject({ slug: 'inner', name: 'Inner' }, 'now');
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
    });

    expect(store.projects.listProjects().map((project) => project.slug)).toEqual(['outer']);
    store.close();
  });

  it('reconciles sources when the config drops one', () => {
    const store = openStore(':memory:');
    const project = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now');
    store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key: 'acme/web', kinds: ['pull_request'] },
      'now',
    );
    store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key: 'acme/api', kinds: ['issue'] },
      'now',
    );

    const removed = store.sources.pruneSources(project.id, [{ driver: 'github', key: 'acme/web' }]);

    expect(removed.map((source) => source.key)).toEqual(['acme/api']);
    expect(store.sources.listSources(project.id).map((source) => source.key)).toEqual(['acme/web']);
    store.close();
  });

  it('records a digest and answers "since last"', () => {
    const store = openStore(':memory:');
    const project = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now');

    expect(store.digests.latestDigest(project.id)).toBeNull();

    store.digests.insertDigest(
      {
        projectId: project.id,
        windowStart: '2026-06-24T00:00:00Z',
        windowEnd: '2026-07-01T00:00:00Z',
        params: { kinds: ['pull_request'] },
        bodyMd: '# Week one',
      },
      '2026-07-01T00:05:00Z',
    );
    const newest = store.digests.insertDigest(
      {
        projectId: project.id,
        windowStart: '2026-07-01T00:00:00Z',
        windowEnd: '2026-07-08T00:00:00Z',
        bodyMd: '# Week two',
      },
      '2026-07-08T00:05:00Z',
    );

    expect(store.digests.latestDigest(project.id)?.id).toBe(newest.id);
    expect(store.digests.latestDigest(project.id)?.windowEnd).toBe('2026-07-08T00:00:00Z');
    expect(store.digests.listDigests(project.id).map((digest) => digest.windowEnd)).toEqual([
      '2026-07-08T00:00:00Z',
      '2026-07-01T00:00:00Z',
    ]);
    expect(store.digests.getDigest(newest.id)?.bodyMd).toBe('# Week two');
    store.close();
  });
});
