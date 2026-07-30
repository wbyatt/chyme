import type {
  EventKind,
  FileChangeStatus,
  SourceActor,
  SourceEvent,
  FileChange,
  ThreadKind,
  ThreadState,
} from '../domain/types.js';
import { openStore, type DigestRow, type ProjectRow, type SourceRow, type Store, type ThreadRow } from '../store/index.js';

/**
 * Store fixtures for the query and render tests.
 *
 * These write through the real repositories along the same path `sync` takes —
 * thread, events, files, references, search index — because a query tested
 * against hand-built rows is a query tested against a store that does not exist.
 */

export function actor(
  handle: string,
  options: { bot?: boolean; name?: string } = {},
): SourceActor {
  return {
    externalId: `U_${handle}`,
    handle,
    displayName: options.name ?? null,
    isBot: options.bot ?? false,
  };
}

export interface EventSeed {
  at: string;
  kind?: EventKind;
  by?: SourceActor | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  detail?: Record<string, unknown> | null;
  externalId?: string;
}

export interface FileSeed {
  path: string;
  status?: FileChangeStatus;
  additions?: number;
  deletions?: number;
  patch?: string | null;
  patchTruncated?: boolean;
  previousPath?: string | null;
}

export interface ThreadSeed {
  number: number;
  createdAt: string;
  /** Source key; defaults to the fixture's first source. */
  source?: string;
  kind?: ThreadKind;
  title?: string;
  state?: ThreadState;
  isDraft?: boolean;
  author?: SourceActor | null;
  body?: string | null;
  /** Defaults to the latest of `createdAt` and the seeded events. */
  updatedAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  labels?: string[];
  events?: EventSeed[];
  files?: FileSeed[];
}

export interface Fixture {
  store: Store;
  project: ProjectRow;
  source(key: string): SourceRow;
  addSource(key: string, kinds?: readonly ThreadKind[]): SourceRow;
  addThread(seed: ThreadSeed): ThreadRow;
  addDigest(windowStart: string, windowEnd: string, bodyMd?: string): DigestRow;
  close(): void;
}

export interface FixtureOptions {
  slug?: string;
  name?: string;
  sources?: readonly string[];
}

export function createFixture(options: FixtureOptions = {}): Fixture {
  const store = openStore(':memory:');
  const slug = options.slug ?? 'platform';
  const project = store.projects.upsertProject(
    { slug, name: options.name ?? 'Platform' },
    '2026-01-01T00:00:00Z',
  );

  const sources = new Map<string, SourceRow>();

  function addSource(key: string, kinds: readonly ThreadKind[] = ['pull_request', 'issue']): SourceRow {
    const source = store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key, kinds },
      '2026-01-01T00:00:00Z',
    );
    sources.set(key, source);
    return source;
  }

  for (const key of options.sources ?? ['acme/api']) addSource(key);

  function source(key: string): SourceRow {
    const found = sources.get(key);
    if (!found) throw new Error(`fixture has no source "${key}"`);
    return found;
  }

  function addThread(seed: ThreadSeed): ThreadRow {
    const target = source(seed.source ?? [...sources.keys()][0]!);
    const kind = seed.kind ?? 'pull_request';
    const eventSeeds = seed.events ?? [];
    const updatedAt =
      seed.updatedAt ??
      eventSeeds.reduce((latest, event) => (event.at > latest ? event.at : latest), seed.createdAt);

    const events: SourceEvent[] = eventSeeds.map((event, index) => ({
      externalId: event.externalId ?? `${kind}-${seed.number}-${index}`,
      kind: event.kind ?? 'comment',
      actor: event.by === undefined ? actor('ada') : event.by,
      createdAt: event.at,
      body: event.body === undefined ? 'A comment body.' : event.body,
      path: event.path ?? null,
      line: event.line ?? null,
      detail: event.detail ?? null,
      raw: null,
    }));

    const files: FileChange[] = (seed.files ?? []).map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status ?? 'modified',
      additions: file.additions ?? 1,
      deletions: file.deletions ?? 0,
      patch: file.patch ?? null,
      patchTruncated: file.patchTruncated ?? false,
    }));

    return store.transaction(() => {
      const thread = store.threads.upsertThread(
        target.id,
        {
          externalId: `${kind}_${target.key}_${seed.number}`,
          kind,
          number: seed.number,
          title: seed.title ?? `Thread ${seed.number}`,
          state: seed.state ?? 'open',
          isDraft: seed.isDraft ?? false,
          author: seed.author === undefined ? actor('ada') : seed.author,
          url: `https://example.test/${target.key}/pull/${seed.number}`,
          body: seed.body === undefined ? 'An opening description.' : seed.body,
          createdAt: seed.createdAt,
          updatedAt,
          closedAt: seed.closedAt ?? null,
          mergedAt: seed.mergedAt ?? null,
          labels: seed.labels ?? [],
          raw: null,
        },
        updatedAt,
      );

      const written = store.events.upsertEvents(thread.id, target.id, events);
      if (files.length > 0) store.fileChanges.replaceFileChanges(thread.id, files);

      store.search.indexThread(
        {
          threadId: thread.id,
          projectId: project.id,
          title: thread.title,
          body: thread.body,
          createdAt: thread.createdAt,
        },
        written.map((event) => ({
          eventId: event.id,
          body: event.body,
          createdAt: event.createdAt,
        })),
      );

      return thread;
    });
  }

  return {
    store,
    project,
    source,
    addSource,
    addThread,
    addDigest: (windowStart, windowEnd, bodyMd = '# Digest') =>
      store.digests.insertDigest(
        { projectId: project.id, windowStart, windowEnd, bodyMd },
        windowEnd,
      ),
    close: () => store.close(),
  };
}
