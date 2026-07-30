import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/schema.js';
import { syncConfigSchema } from '../config/schema.js';
import type {
  ExtractedReference,
  SourceEvent,
  FileChange,
  ThreadDetail,
  ThreadSummary,
  SourceRef,
  ThreadKind,
  ThreadRef,
} from '../domain/types.js';
import type { SourceDriver, ListThreadsOptions } from '../drivers/types.js';
import { queryActivity } from '../query/activity.js';
import { resolveWindow } from '../query/window.js';
import { renderActivity } from '../render/activity.js';
import { openStore, type Store } from '../store/index.js';
import { ChymeError } from '../util/errors.js';
import { syncFailed, syncProject, type DriverResolver } from './sync.js';

// Most tests want the unbounded behaviour so their fixed 2026 timestamps are
// not silently filtered by the first-sync window; that window has its own test.
const SYNC = syncConfigSchema.parse({ firstSyncSince: null });

function detail(overrides: Partial<ThreadDetail> & { number: number }): ThreadDetail {
  const number = overrides.number;
  return {
    externalId: `PR_${number}`,
    kind: 'pull_request',
    title: `Change ${number}`,
    state: 'open',
    isDraft: false,
    author: { externalId: 'U1', handle: 'kai', displayName: 'Kai', isBot: false },
    url: `https://example.test/pull/${number}`,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    labels: [],
    raw: { number },
    body: null,
    events: [],
    files: [],
    ...overrides,
  };
}

function comment(id: string, createdAt: string, body: string): SourceEvent {
  return {
    externalId: id,
    kind: 'comment',
    actor: { externalId: 'U2', handle: 'ren', displayName: 'Ren', isBot: false },
    createdAt,
    body,
    path: null,
    line: null,
    detail: null,
    raw: { id },
  };
}

function file(path: string, patch: string | null, truncated = false): FileChange {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch,
    patchTruncated: truncated,
  };
}

/** Records what was asked of it so tests can assert on API traffic, not just results. */
class FakeDriver implements SourceDriver {
  readonly id: string;
  readonly detailFetches: string[] = [];
  readonly listCalls: (string | null)[] = [];
  private readonly threads = new Map<string, ThreadDetail>();
  failWith: Error | null = null;
  /** Thread keys (`kind#number`) whose detail fetch throws deterministically. */
  readonly failDetail = new Set<string>();
  /** Thread kinds whose listing throws. */
  readonly failListKinds = new Set<string>();

  constructor(id = 'fake') {
    this.id = id;
  }

  put(thread: ThreadDetail): void {
    this.threads.set(`${thread.kind}#${thread.number}`, thread);
  }

  parseSourceKey(input: string): string {
    return input;
  }

  describeSource(key: string): string {
    return key;
  }

  async *listThreadsUpdatedSince(
    _source: SourceRef,
    options: ListThreadsOptions,
  ): AsyncIterable<ThreadSummary> {
    if (this.failWith) throw this.failWith;
    for (const kind of options.kinds) {
      if (this.failListKinds.has(kind)) throw new Error(`${kind} listing is down`);
    }
    this.listCalls.push(options.since);

    const matching = [...this.threads.values()]
      .filter((thread) => options.kinds.includes(thread.kind))
      // Inclusive, matching the driver contract: re-seeing the boundary thread
      // is safe because upserts are idempotent, whereas skipping it is not.
      .filter((thread) => options.since === null || thread.updatedAt >= options.since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number);

    for (const thread of matching) {
      const { body: _body, events: _events, files: _files, ...summary } = thread;
      yield summary;
    }
  }

  async fetchThreadDetail(
    _source: SourceRef,
    ref: ThreadRef,
    options: { includePatches: boolean },
  ): Promise<ThreadDetail> {
    const key = `${ref.kind}#${ref.number}`;
    this.detailFetches.push(key);
    if (this.failDetail.has(key)) throw new Error(`${key} cannot be read`);
    const thread = this.threads.get(key);
    if (!thread) throw new Error(`fake driver has no ${key}`);
    if (options.includePatches) return thread;
    // Matching the real driver: not asking for hunks strips the patch text, it
    // does not claim the change touched no files.
    return {
      ...thread,
      files: thread.files.map((entry) => ({ ...entry, patch: null, patchTruncated: false })),
    };
  }

  extractReferences(text: string): ExtractedReference[] {
    return [...text.matchAll(/#(\d+)/g)].map((match) => ({
      refKind: 'thread',
      refRaw: match[0],
      hint: { number: Number(match[1]) },
    }));
  }
}

function projectConfig(
  sources: { driver: string; key: string }[],
  kinds: readonly ThreadKind[] = ['pull_request'],
): ProjectConfig {
  return {
    slug: 'platform',
    name: 'Platform',
    sources: sources.map((source) => ({ ...source, kinds: [...kinds] })),
  } as ProjectConfig;
}

describe('syncProject', () => {
  let store: Store;
  let driver: FakeDriver;
  let resolve: DriverResolver;

  beforeEach(() => {
    store = openStore(':memory:');
    driver = new FakeDriver();
    resolve = () => driver;
  });

  it('writes threads, events and files, and records a watermark', async () => {
    driver.put(
      detail({
        number: 1,
        updatedAt: '2026-07-10T00:00:00Z',
        body: 'fixes #99',
        events: [comment('c1', '2026-07-09T00:00:00Z', 'this duplicates #42')],
        files: [file('src/a.ts', '@@ -1 +1 @@')],
      }),
    );

    const report = await syncProject(store, projectConfig([{ driver: 'fake', key: 'acme/api' }]), resolve, SYNC);

    expect(report.sources[0]).toMatchObject({
      threadsWritten: 1,
      threadsUnchanged: 0,
      eventsWritten: 1,
      filesWritten: 1,
      error: null,
      hitRunLimit: false,
    });

    const project = store.projects.requireProject('platform');
    const source = store.sources.listSources(project.id)[0]!;
    expect(store.cursors.getCursorValue(source.id, 'updated_at:pull_request')).toBe(
      '2026-07-10T00:00:00Z',
    );

    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    expect(thread.body).toBe('fixes #99');
    expect(store.events.listEventsForThread(thread.id)).toHaveLength(1);
    expect(store.fileChanges.listFileChanges(thread.id)[0]?.patch).toBe('@@ -1 +1 @@');
  });

  it('does not refetch detail for a thread whose watermark has not moved', async () => {
    driver.put(detail({ number: 1 }));
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);

    await syncProject(store, config, resolve, SYNC);
    expect(driver.detailFetches).toEqual(['pull_request#1']);

    const second = await syncProject(store, config, resolve, SYNC);
    expect(driver.detailFetches).toEqual(['pull_request#1']);
    expect(second.sources[0]).toMatchObject({ threadsUnchanged: 1, threadsWritten: 0 });
  });

  it('refetches a thread that moved, even though it was created long ago', async () => {
    driver.put(detail({ number: 1, createdAt: '2026-06-01T00:00:00Z' }));
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    await syncProject(store, config, resolve, SYNC);

    driver.put(
      detail({
        number: 1,
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        events: [comment('c9', '2026-07-20T00:00:00Z', 'actually this is wrong')],
      }),
    );

    const report = await syncProject(store, config, resolve, SYNC);
    expect(report.sources[0]).toMatchObject({ threadsWritten: 1, eventsWritten: 1 });

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    expect(store.cursors.getCursorValue(source.id, 'updated_at:pull_request')).toBe(
      '2026-07-20T00:00:00Z',
    );
  });

  it('stops at the run limit and resumes from the correct place', async () => {
    for (const number of [1, 2, 3]) {
      driver.put(detail({ number, updatedAt: `2026-07-1${number}T00:00:00Z` }));
    }
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    const limited = syncConfigSchema.parse({ maxThreadsPerRun: 1, firstSyncSince: null });

    const first = await syncProject(store, config, resolve, limited);
    expect(first.sources[0]).toMatchObject({ threadsWritten: 1, hitRunLimit: true });

    const second = await syncProject(store, config, resolve, limited);
    expect(second.sources[0]).toMatchObject({ threadsWritten: 1, hitRunLimit: true });

    const third = await syncProject(store, config, resolve, limited);
    expect(third.sources[0]).toMatchObject({ threadsWritten: 1 });

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    expect(store.threads.listThreadsForSource(source.id)).toHaveLength(3);
  });

  it('budgets each thread kind separately so neither starves the other', async () => {
    // A shared budget would be spent entirely on pull requests here, and the
    // issue would never sync no matter how many times the user ran sync.
    driver.put(detail({ number: 1, updatedAt: '2026-07-11T00:00:00Z' }));
    driver.put(detail({ number: 2, updatedAt: '2026-07-12T00:00:00Z' }));
    driver.put(
      detail({
        number: 90,
        kind: 'issue',
        externalId: 'I_90',
        updatedAt: '2026-07-13T00:00:00Z',
      }),
    );

    const report = await syncProject(
      store,
      projectConfig([{ driver: 'fake', key: 'acme/api' }], ['pull_request', 'issue']),
      resolve,
      syncConfigSchema.parse({ maxThreadsPerRun: 1, firstSyncSince: null }),
    );

    expect(report.sources[0]).toMatchObject({ threadsWritten: 2, hitRunLimit: true });
    expect(driver.detailFetches).toEqual(['pull_request#1', 'issue#90']);
  });

  it('carries a non-git source through sync and query using its own vocabulary', async () => {
    // The proof that the driver abstraction sits at "a thread of discourse" and
    // not at "a pull request". Nothing here is a kind, state, or event type that
    // any git forge emits, and no layer needs to be taught about them.
    const tracker = new FakeDriver('tracker');
    tracker.put(
      detail({
        number: 88,
        kind: 'ticket',
        externalId: 'PROJ-88',
        state: 'in_progress',
        title: 'Latency spike in checkout',
        body: 'Started right after the cache change',
        url: 'https://tracker.test/PROJ-88',
        updatedAt: '2026-07-15T00:00:00Z',
        files: [],
        events: [
          {
            externalId: 'n1',
            kind: 'status_note',
            actor: { externalId: 'U9', handle: 'ren', displayName: 'Ren', isBot: false },
            createdAt: '2026-07-15T00:00:00Z',
            body: 'Moved to In Progress; suspect the cache change',
            path: null,
            line: null,
            detail: { from: 'triage', to: 'in_progress' },
            raw: {},
          },
        ],
      }),
    );

    const report = await syncProject(
      store,
      projectConfig([{ driver: 'tracker', key: 'PROJ' }], ['ticket']),
      () => tracker,
      SYNC,
      { now: () => new Date('2026-07-20T00:00:00Z') },
    );
    expect(report.sources[0]).toMatchObject({ threadsWritten: 1, eventsWritten: 1, error: null });

    const project = store.projects.requireProject('platform');
    const source = store.sources.listSources(project.id)[0]!;

    const thread = store.threads.findThread(source.id, 'ticket', 88)!;
    expect(thread.state).toBe('in_progress');
    expect(store.events.listEventsForThread(thread.id)[0]?.kind).toBe('status_note');
    expect(store.cursors.getCursorValue(source.id, 'updated_at:ticket')).toBe(
      '2026-07-15T00:00:00Z',
    );

    const window = resolveWindow(store, project.id, {
      since: { kind: 'instant', at: '2026-07-01T00:00:00Z' },
      now: new Date('2026-07-20T00:00:00Z'),
    });
    const activity = queryActivity(store, project, window);
    expect(activity.threads).toHaveLength(1);
    expect(activity.threads[0]?.thread.kind).toBe('ticket');

    // The unknown event kind must survive rendering rather than being dropped
    // for not appearing in a hardcoded list.
    const rendered = renderActivity(activity, { now: new Date('2026-07-20T00:00:00Z') });
    expect(rendered).toContain('ticket');
    expect(rendered).toContain('status note');
    expect(rendered).toContain('Latency spike in checkout');
  });

  it('reports a failing source without abandoning the others', async () => {
    const healthy = new FakeDriver('healthy');
    healthy.put(detail({ number: 7 }));
    const broken = new FakeDriver('broken');
    broken.failWith = new Error('403 from the source');

    const report = await syncProject(
      store,
      projectConfig([
        { driver: 'broken', key: 'acme/secret' },
        { driver: 'healthy', key: 'acme/api' },
      ]),
      (id) => (id === 'broken' ? broken : healthy),
      SYNC,
    );

    const failed = report.sources.find((source) => source.driver === 'broken')!;
    const ok = report.sources.find((source) => source.driver === 'healthy')!;
    expect(failed.error).toContain('403');
    expect(ok.error).toBeNull();
    expect(ok.threadsWritten).toBe(1);
  });

  it('indexes synced content for search', async () => {
    driver.put(
      detail({
        number: 1,
        title: 'Rework the migration tooling',
        events: [comment('c1', '2026-07-09T00:00:00Z', 'the fixtures keep drifting')],
      }),
    );
    await syncProject(store, projectConfig([{ driver: 'fake', key: 'acme/api' }]), resolve, SYNC);

    expect(store.search.search({ text: 'migration' })).toHaveLength(1);
    expect(store.search.search({ text: 'fixtures' })[0]?.entityKind).toBe('event');
  });

  it('stores references found in both the thread and its events', async () => {
    driver.put(
      detail({
        number: 1,
        body: 'follows on from #12',
        events: [comment('c1', '2026-07-09T00:00:00Z', 'see also #34')],
      }),
    );
    await syncProject(store, projectConfig([{ driver: 'fake', key: 'acme/api' }]), resolve, SYNC);

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    const event = store.events.listEventsForThread(thread.id)[0]!;

    expect(store.references.listReferencesFrom({ kind: 'thread', id: thread.id })).toMatchObject([
      { refRaw: '#12' },
    ]);
    expect(store.references.listReferencesFrom({ kind: 'event', id: event.id })).toMatchObject([
      { refRaw: '#34' },
    ]);
  });

  it('drops a source the config has stopped listing, with everything synced from it', async () => {
    driver.put(detail({ number: 1 }));
    await syncProject(store, projectConfig([{ driver: 'fake', key: 'acme/api' }]), resolve, SYNC);

    const report = await syncProject(store, projectConfig([]), resolve, SYNC);
    expect(report.removedSources).toEqual(['fake:acme/api']);

    const project = store.projects.requireProject('platform');
    expect(store.sources.listSources(project.id)).toHaveLength(0);
    expect(store.threads.countThreads(project.id)).toBe(0);
  });

  it('re-reads everything when asked for a full sync', async () => {
    driver.put(detail({ number: 1 }));
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);

    await syncProject(store, config, resolve, SYNC);
    await syncProject(store, config, resolve, SYNC);
    await syncProject(store, config, resolve, SYNC, { full: true });

    // The middle run reuses the watermark and skips the unchanged thread; the
    // full run ignores both and re-reads it.
    expect(driver.listCalls).toEqual([null, '2026-07-10T00:00:00Z', null]);
    expect(driver.detailFetches).toEqual(['pull_request#1', 'pull_request#1']);
  });

  it('resumes a full sync that hit the run limit instead of restarting it', async () => {
    // A full sync bypasses the unchanged check, so if it also restarted from the
    // beginning every run it would re-read the same first N threads forever and
    // never reach the tail — while the report told the user to run it again.
    for (const number of [1, 2, 3, 4]) {
      driver.put(detail({ number, updatedAt: `2026-07-1${number}T00:00:00Z` }));
    }
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    const limited = syncConfigSchema.parse({ maxThreadsPerRun: 2, firstSyncSince: null });

    // The property is convergence: repeating the command must finish the job.
    // Previously every run restarted from the beginning and this never
    // terminated, while the report kept saying "run sync again to continue".
    let runs = 0;
    let hitLimit = true;
    while (hitLimit && runs < 10) {
      const report = await syncProject(store, config, resolve, limited, { full: true });
      hitLimit = report.sources[0]?.hitRunLimit ?? false;
      runs += 1;
    }

    expect(runs).toBeLessThan(10);
    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    expect(store.threads.listThreadsForSource(source.id).map((t) => t.number).sort()).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('steps past a thread it cannot read, and says which one', async () => {
    for (const number of [1, 2, 3]) {
      driver.put(detail({ number, updatedAt: `2026-07-1${number}T00:00:00Z` }));
    }
    driver.failDetail.add('pull_request#2');
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);

    const first = await syncProject(store, config, resolve, SYNC);
    expect(first.sources[0]?.threadsWritten).toBe(2);
    expect(first.sources[0]?.failedThreads).toMatchObject([
      { number: 2, updatedAt: '2026-07-12T00:00:00Z' },
    ]);

    // Without stepping past it, #3 would be unreachable on every future run.
    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    expect(store.threads.findThread(source.id, 'pull_request', 3)).not.toBeNull();
  });

  it('keeps syncing one thread kind when another kind fails', async () => {
    driver.put(detail({ number: 1 }));
    driver.failListKinds.add('issue');

    const report = await syncProject(
      store,
      projectConfig([{ driver: 'fake', key: 'acme/api' }], ['issue', 'pull_request']),
      resolve,
      SYNC,
    );

    expect(report.sources[0]?.error).toContain('issue');
    // The per-kind cursors exist so one kind cannot hold up another.
    expect(report.sources[0]?.threadsWritten).toBe(1);
  });

  it('clears file changes a thread no longer has', async () => {
    driver.put(detail({ number: 1, files: [file('src/a.ts', '@@ -1 +1 @@')] }));
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    await syncProject(store, config, resolve, SYNC);

    // A force-push reduces the branch to nothing; the old rows must not survive
    // as phantom changes that --path still matches.
    driver.put(detail({ number: 1, updatedAt: '2026-07-11T00:00:00Z', files: [] }));
    await syncProject(store, config, resolve, SYNC);

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    expect(store.fileChanges.listFileChanges(thread.id)).toHaveLength(0);
  });

  it('keeps stored hunks when a later sync is not asking for them', async () => {
    const withPatches = syncConfigSchema.parse({ firstSyncSince: null });
    const withoutPatches = syncConfigSchema.parse({
      firstSyncSince: null,
      includePatches: false,
    });
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);

    driver.put(detail({ number: 1, files: [file('src/a.ts', '@@ -1 +1 @@')] }));
    await syncProject(store, config, resolve, withPatches);

    // Turning includePatches off should stop fetching diffs, not delete the ones
    // already fetched — and must never claim nothing was withheld.
    driver.put(detail({ number: 1, updatedAt: '2026-07-11T00:00:00Z', files: [file('src/a.ts', '@@ -1 +1 @@')] }));
    await syncProject(store, config, resolve, withoutPatches);

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    expect(store.fileChanges.listFileChanges(thread.id)[0]?.patch).toBe('@@ -1 +1 @@');
  });

  it('drops events and their references when the source stops reporting them', async () => {
    driver.put(
      detail({
        number: 1,
        events: [comment('c1', '2026-07-09T00:00:00Z', 'zebracake, and see #34')],
      }),
    );
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    await syncProject(store, config, resolve, SYNC);
    expect(store.search.search({ text: 'zebracake' })).toHaveLength(1);

    driver.put(detail({ number: 1, updatedAt: '2026-07-11T00:00:00Z', events: [] }));
    await syncProject(store, config, resolve, SYNC);

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    // `thread` and `search` must not disagree about what the thread contains.
    expect(store.events.listEventsForThread(thread.id)).toHaveLength(0);
    expect(store.search.search({ text: 'zebracake' })).toHaveLength(0);
  });

  it('takes back references from a comment edited down to nothing', async () => {
    driver.put(
      detail({ number: 1, events: [comment('c1', '2026-07-09T00:00:00Z', 'see also #34')] }),
    );
    const config = projectConfig([{ driver: 'fake', key: 'acme/api' }]);
    await syncProject(store, config, resolve, SYNC);

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    const thread = store.threads.findThread(source.id, 'pull_request', 1)!;
    const event = store.events.listEventsForThread(thread.id)[0]!;
    expect(store.references.listReferencesFrom({ kind: 'event', id: event.id })).toHaveLength(1);

    driver.put(
      detail({
        number: 1,
        updatedAt: '2026-07-11T00:00:00Z',
        events: [{ ...comment('c1', '2026-07-09T00:00:00Z', ''), body: null }],
      }),
    );
    await syncProject(store, config, resolve, SYNC);

    expect(store.references.listReferencesFrom({ kind: 'event', id: event.id })).toHaveLength(0);
  });

  it('bounds a first sync to a recent window and reports the bound', async () => {
    driver.put(detail({ number: 1, updatedAt: '2026-07-10T00:00:00Z' }));
    driver.put(detail({ number: 2, updatedAt: '2020-01-01T00:00:00Z' }));

    const report = await syncProject(
      store,
      projectConfig([{ driver: 'fake', key: 'acme/api' }]),
      resolve,
      syncConfigSchema.parse({ firstSyncSince: '90d' }),
      { now: () => new Date('2026-07-20T00:00:00Z') },
    );

    expect(driver.listCalls[0]).toBe('2026-04-21T00:00:00Z');
    expect(report.sources[0]?.firstSyncFrom).toBe('2026-04-21T00:00:00Z');
    expect(report.sources[0]?.threadsWritten).toBe(1);
  });

  it('reads further back when explicitly asked', async () => {
    driver.put(detail({ number: 2, updatedAt: '2020-01-01T00:00:00Z' }));

    await syncProject(
      store,
      projectConfig([{ driver: 'fake', key: 'acme/api' }]),
      resolve,
      syncConfigSchema.parse({ firstSyncSince: '90d' }),
      { now: () => new Date('2026-07-20T00:00:00Z'), since: '2019-01-01T00:00:00Z' },
    );

    const source = store.sources.listSources(store.projects.requireProject('platform').id)[0]!;
    expect(store.threads.findThread(source.id, 'pull_request', 2)).not.toBeNull();
  });

  it('stops the whole run when interrupted, rather than failing every source', async () => {
    const controller = new AbortController();
    const aborting = new FakeDriver('aborting');
    aborting.failWith = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });

    const report = await syncProject(
      store,
      projectConfig([
        { driver: 'aborting', key: 'acme/api' },
        { driver: 'aborting', key: 'acme/worker' },
      ]),
      () => aborting,
      SYNC,
      { signal: controller.signal },
    );

    // Someone who pressed Ctrl-C must not be told two repositories failed.
    expect(report.aborted).toBe(true);
    expect(report.sources).toHaveLength(0);
    expect(syncFailed(report)).toBe(false);
  });

  it('keeps a failure hint rather than reducing it to a bare message', async () => {
    const broken = new FakeDriver('broken');
    broken.failWith = new ChymeError('Rate limit exhausted.', 'The limit resets in 43m.');

    const report = await syncProject(
      store,
      projectConfig([{ driver: 'broken', key: 'acme/api' }]),
      () => broken,
      SYNC,
    );

    expect(report.sources[0]?.error).toContain('resets in 43m');
  });
});
