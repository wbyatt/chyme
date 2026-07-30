import type { ProjectConfig, SyncConfig } from '../config/schema.js';
import type { SourceRef, ThreadKind } from '../domain/types.js';
import type { SourceDriver } from '../drivers/types.js';
import type { ProjectRow, SourceRow, Store } from '../store/index.js';
import { toIso } from '../util/time.js';
import { reconcileProject } from './reconcile.js';

/**
 * Pull everything that has moved in a project's sources into the store.
 *
 * The engine takes a driver *resolver* rather than a registry so it depends
 * only on the SourceDriver interface — which is also what makes it testable
 * against a fake driver with no network.
 */
export type DriverResolver = (driverId: string) => SourceDriver;

/**
 * One watermark per source per thread kind. Splitting them lets issues and pull
 * requests make progress independently, so a failure fetching one does not
 * rewind the other.
 */
function cursorKind(kind: ThreadKind): string {
  return `updated_at:${kind}`;
}

export interface SyncOptions {
  /** Ignore stored watermarks and re-read every thread from the beginning. */
  full?: boolean;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => Date;
  onProgress?: (event: SyncProgress) => void;
}

export type SyncProgress =
  | { kind: 'source-start'; driver: string; key: string }
  | {
      kind: 'thread';
      driver: string;
      key: string;
      threadKind: ThreadKind;
      number: number;
      title: string;
      outcome: 'written' | 'unchanged';
    }
  | { kind: 'source-done'; driver: string; key: string; error: string | null };

export interface SourceSyncReport {
  driver: string;
  key: string;
  threadsSeen: number;
  threadsWritten: number;
  threadsUnchanged: number;
  eventsWritten: number;
  filesWritten: number;
  /**
   * True when `maxThreadsPerRun` stopped the run early. The cursor is still
   * correct, so running sync again resumes exactly where this one stopped.
   */
  hitRunLimit: boolean;
  error: string | null;
}

export interface SyncReport {
  projectSlug: string;
  startedAt: string;
  finishedAt: string;
  sources: SourceSyncReport[];
  /** Sources dropped because the config stopped listing them. */
  removedSources: string[];
}

export function syncFailed(report: SyncReport): boolean {
  return report.sources.some((source) => source.error !== null);
}

export async function syncProject(
  store: Store,
  projectConfig: ProjectConfig,
  resolveDriver: DriverResolver,
  syncConfig: SyncConfig,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const clock = options.now ?? (() => new Date());
  const startedAt = toIso(clock());

  const { project, sources, removed } = reconcileProject(store, projectConfig, startedAt);

  const reports: SourceSyncReport[] = [];
  for (const source of sources) {
    reports.push(
      await syncSource(store, project, source, resolveDriver, syncConfig, options, clock),
    );
  }

  return {
    projectSlug: project.slug,
    startedAt,
    finishedAt: toIso(clock()),
    sources: reports,
    removedSources: removed.map((source) => `${source.driver}:${source.key}`),
  };
}

async function syncSource(
  store: Store,
  project: ProjectRow,
  source: SourceRow,
  resolveDriver: DriverResolver,
  syncConfig: SyncConfig,
  options: SyncOptions,
  clock: () => Date,
): Promise<SourceSyncReport> {
  const report: SourceSyncReport = {
    driver: source.driver,
    key: source.key,
    threadsSeen: 0,
    threadsWritten: 0,
    threadsUnchanged: 0,
    eventsWritten: 0,
    filesWritten: 0,
    hitRunLimit: false,
    error: null,
  };

  options.onProgress?.({ kind: 'source-start', driver: source.driver, key: source.key });

  try {
    const driver = resolveDriver(source.driver);
    const ref: SourceRef = { driver: source.driver, key: source.key };

    for (const threadKind of source.kinds) {
      // The budget is per kind, not shared across them. A shared budget starves
      // whichever kind sorts last: on a busy repository pull requests would eat
      // it every run and issues would never sync at all.
      let budget = syncConfig.maxThreadsPerRun;

      const cursor = cursorKind(threadKind);
      const since = options.full ? null : store.cursors.getCursorValue(source.id, cursor);

      const stream = driver.listThreadsUpdatedSince(ref, {
        since,
        kinds: [threadKind],
        ...(options.signal ? { signal: options.signal } : {}),
      });

      for await (const summary of stream) {
        options.signal?.throwIfAborted();
        report.threadsSeen += 1;

        if (budget <= 0) {
          // Stop consuming rather than draining the stream to count what is
          // left: counting would cost the same paginated API calls the limit
          // exists to avoid. The cursor is accurate, so the next run continues
          // from here.
          report.hitRunLimit = true;
          break;
        }

        const existing = store.threads.findThread(source.id, threadKind, summary.number);
        // A full sync must bypass this: its whole purpose is repairing a store
        // whose contents are suspect, and trusting the stored watermark to
        // decide what to re-read would make `--full` almost a no-op.
        if (!options.full && existing && existing.updatedAt === summary.updatedAt) {
          // A thread is only committed once its detail has been written, so an
          // unchanged watermark genuinely means nothing new to fetch.
          store.cursors.advanceCursor(source.id, cursor, summary.updatedAt, toIso(clock()));
          report.threadsUnchanged += 1;
          options.onProgress?.({
            kind: 'thread',
            driver: source.driver,
            key: source.key,
            threadKind,
            number: summary.number,
            title: summary.title,
            outcome: 'unchanged',
          });
          continue;
        }

        const detail = await driver.fetchThreadDetail(
          ref,
          { kind: threadKind, number: summary.number },
          {
            // Whether a kind even *has* change artifacts is the driver's
            // business, not the engine's. This used to read `&& threadKind ===
            // 'pull_request'`, which put git vocabulary in source-neutral code
            // and would have been wrong for the first non-git source.
            includePatches: syncConfig.includePatches,
            maxPatchBytes: syncConfig.maxPatchBytes,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );

        const now = toIso(clock());

        // One transaction per thread: an interrupted sync leaves whole threads
        // behind, never half of one, and the cursor moves only with the commit.
        store.transaction(() => {
          const thread = store.threads.upsertThread(source.id, detail, now);
          const events = store.events.upsertEvents(thread.id, source.id, detail.events);

          const files =
            detail.files.length > 0
              ? store.fileChanges.replaceFileChanges(thread.id, detail.files)
              : [];

          store.references.replaceReferences(
            { kind: 'thread', id: thread.id },
            driver.extractReferences(`${detail.title}\n${detail.body ?? ''}`),
          );
          for (const event of events) {
            if (!event.body) continue;
            store.references.replaceReferences(
              { kind: 'event', id: event.id },
              driver.extractReferences(event.body),
            );
          }

          store.search.indexThread(
            {
              threadId: thread.id,
              projectId: project.id,
              title: thread.title,
              body: thread.body,
              createdAt: thread.createdAt,
            },
            events.map((event) => ({
              eventId: event.id,
              body: event.body,
              createdAt: event.createdAt,
            })),
          );

          store.cursors.advanceCursor(source.id, cursor, summary.updatedAt, now);

          report.eventsWritten += events.length;
          report.filesWritten += files.length;
        });

        budget -= 1;
        report.threadsWritten += 1;
        options.onProgress?.({
          kind: 'thread',
          driver: source.driver,
          key: source.key,
          threadKind,
          number: summary.number,
          title: summary.title,
          outcome: 'written',
        });
      }
    }
  } catch (error) {
    // One unreachable or unauthorized repository must not abandon the others in
    // a multi-repo project; the failure is reported and the run continues.
    report.error = error instanceof Error ? error.message : String(error);
  }

  options.onProgress?.({
    kind: 'source-done',
    driver: source.driver,
    key: source.key,
    error: report.error,
  });

  return report;
}
