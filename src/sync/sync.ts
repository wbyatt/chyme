import type { ProjectConfig, SyncConfig } from '../config/schema.js';
import type { SourceRef, ThreadKind } from '../domain/types.js';
import type { SourceDriver } from '../drivers/types.js';
import type { ProjectRow, SourceRow, Store } from '../store/index.js';
import { ChymeError } from '../util/errors.js';
import { parseTimeSpec, toIso } from '../util/time.js';
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
 * One watermark per source per thread kind. Splitting them lets each kind make
 * progress independently, so a failure fetching one does not rewind the other.
 */
function cursorKind(kind: ThreadKind): string {
  return `updated_at:${kind}`;
}

/**
 * Resume marker for an in-progress `--full` pass.
 *
 * A full sync cannot resume from the ordinary watermark: it deliberately
 * re-reads threads the watermark calls unchanged, so using that watermark as its
 * starting point would restart the pass from the beginning every run and, once
 * the run limit trips, never reach the tail at all. Its own marker resumes where
 * it stopped, and is cleared when the pass completes.
 */
function fullCursorKind(kind: ThreadKind): string {
  return `full:updated_at:${kind}`;
}

export interface SyncOptions {
  /** Re-read every thread rather than trusting the stored watermarks. */
  full?: boolean;
  /**
   * Start from this instant instead of the stored watermark. Used to reach back
   * past a first sync's window, or to retry a thread that failed.
   */
  since?: string | null;
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
      outcome: 'written' | 'unchanged' | 'failed';
    }
  | { kind: 'source-done'; driver: string; key: string; error: string | null };

/** A thread the run could not read. Recorded rather than retried forever. */
export interface FailedThread {
  threadKind: ThreadKind;
  number: number;
  /** The watermark the run stepped past to get here, so it can be retried. */
  updatedAt: string;
  error: string;
}

export interface SourceSyncReport {
  driver: string;
  key: string;
  threadsSeen: number;
  threadsWritten: number;
  threadsUnchanged: number;
  eventsWritten: number;
  filesWritten: number;
  /**
   * True when `maxThreadsPerRun` stopped a kind early. The watermark is still
   * accurate, so running sync again resumes where this one stopped.
   */
  hitRunLimit: boolean;
  /**
   * Set when this run bounded a first sync to a recent window rather than
   * reading a source's entire history. Reported so the bound is never silent.
   */
  firstSyncFrom: string | null;
  /** Threads that could not be read. The run steps past them and says so. */
  failedThreads: FailedThread[];
  error: string | null;
}

export interface SyncReport {
  projectSlug: string;
  startedAt: string;
  finishedAt: string;
  sources: SourceSyncReport[];
  /** Sources dropped because the config stopped listing them. */
  removedSources: string[];
  /** True when the run stopped early because it was interrupted. */
  aborted: boolean;
}

export function syncFailed(report: SyncReport): boolean {
  return report.sources.some(
    (source) => source.error !== null || source.failedThreads.length > 0,
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Render a failure for the report.
 *
 * A ChymeError's hint is the actionable half — "the limit resets in 43m" — and
 * dropping it here would discard it in exactly the situation the user needs it.
 * Anything that is not a ChymeError is a bug rather than a source being
 * unreachable, and is labelled so the two are never confused.
 */
function describeError(error: unknown): string {
  if (error instanceof ChymeError) {
    return error.hint ? `${error.message} — ${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return `[bug] ${error.name}: ${error.message}`;
  }
  return `[bug] ${String(error)}`;
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
  let aborted = false;

  for (const source of sources) {
    try {
      reports.push(
        await syncSource(store, project, source, resolveDriver, syncConfig, options, clock),
      );
    } catch (error) {
      if (!isAbort(error)) throw error;
      // An interrupt is not "this source is unreachable". Attempting the
      // remaining sources would fail each of them on the same signal and report
      // a project-wide outage to someone who simply pressed Ctrl-C.
      aborted = true;
      break;
    }
  }

  return {
    projectSlug: project.slug,
    startedAt,
    finishedAt: toIso(clock()),
    sources: reports,
    removedSources: removed.map((source) => `${source.driver}:${source.key}`),
    aborted,
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
    firstSyncFrom: null,
    failedThreads: [],
    error: null,
  };

  options.onProgress?.({ kind: 'source-start', driver: source.driver, key: source.key });

  const errors: string[] = [];

  try {
    const driver = resolveDriver(source.driver);
    const ref: SourceRef = { driver: source.driver, key: source.key };

    for (const threadKind of source.kinds) {
      try {
        await syncKind(store, project, source, driver, ref, threadKind, syncConfig, options, clock, report);
      } catch (error) {
        if (isAbort(error)) throw error;
        // Isolated per kind. The cursors were split so a failure in one does not
        // hold up another; letting the throw escape this loop would have given
        // that back, abandoning healthy kinds on the first unhealthy one.
        errors.push(`${threadKind}: ${describeError(error)}`);
      }
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    // Resolving the driver failed — bad credentials, unknown driver id. Nothing
    // kind-specific to attribute it to.
    errors.push(describeError(error));
  }

  report.error = errors.length > 0 ? errors.join('; ') : null;

  options.onProgress?.({
    kind: 'source-done',
    driver: source.driver,
    key: source.key,
    error: report.error,
  });

  return report;
}

async function syncKind(
  store: Store,
  project: ProjectRow,
  source: SourceRow,
  driver: SourceDriver,
  ref: SourceRef,
  threadKind: ThreadKind,
  syncConfig: SyncConfig,
  options: SyncOptions,
  clock: () => Date,
  report: SourceSyncReport,
): Promise<void> {
  // The budget is per kind, not shared across them. A shared budget starves
  // whichever kind sorts last: on a busy repository pull requests would eat it
  // every run and issues would never sync at all.
  let budget = syncConfig.maxThreadsPerRun;

  const cursor = cursorKind(threadKind);
  const fullCursor = fullCursorKind(threadKind);
  const since = resolveSince(store, source, threadKind, syncConfig, options, clock, report);

  const stream = driver.listThreadsUpdatedSince(ref, {
    since,
    kinds: [threadKind],
    ...(options.signal ? { signal: options.signal } : {}),
  });

  let exhausted = true;

  for await (const summary of stream) {
    options.signal?.throwIfAborted();
    report.threadsSeen += 1;

    if (budget <= 0) {
      // Stop consuming rather than draining the rest of the stream. The
      // watermark is accurate — for a full pass, its own marker holds the
      // resume point — so the next run continues from here.
      report.hitRunLimit = true;
      exhausted = false;
      break;
    }

    const advance = (): void => {
      const at = toIso(clock());
      store.cursors.advanceCursor(source.id, cursor, summary.updatedAt, at);
      if (options.full) store.cursors.advanceCursor(source.id, fullCursor, summary.updatedAt, at);
    };

    const existing = store.threads.findThread(source.id, threadKind, summary.number);
    // A full sync must bypass this: its whole purpose is repairing a store whose
    // contents are suspect, and trusting the stored watermark to decide what to
    // re-read would make `--full` almost a no-op.
    if (!options.full && existing && existing.updatedAt === summary.updatedAt) {
      // A thread is only committed once its detail has been written, so an
      // unchanged watermark genuinely means nothing new to fetch.
      advance();
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

    try {
      const detail = await driver.fetchThreadDetail(
        ref,
        { kind: summary.kind, number: summary.number },
        {
          // Whether a kind even *has* change artifacts is the driver's business,
          // not the engine's. This used to read `&& threadKind ===
          // 'pull_request'`, which put git vocabulary in source-neutral code and
          // would have been wrong for the first non-git source.
          includePatches: syncConfig.includePatches,
          maxPatchBytes: syncConfig.maxPatchBytes,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );

      const now = toIso(clock());

      // One transaction per thread: an interrupted sync leaves whole threads
      // behind, never half of one, and the watermark moves only with the commit.
      store.transaction(() => {
        const thread = store.threads.upsertThread(source.id, detail, now);
        const events = store.events.upsertEvents(thread.id, source.id, detail.events);
        // A detail fetch returns the whole event list, so anything missing from
        // it was deleted upstream. Without this the event table only ever grew
        // while the search index was rebuilt from the fetch, and the two views
        // of one thread disagreed with nothing to say so.
        store.events.pruneEvents(
          thread.id,
          detail.events.map((event) => event.externalId),
        );

        // Unconditionally, including with an empty list: a force-push or a
        // revert removes files from a change, and guarding this on a non-empty
        // list would leave the old rows behind as phantom changes that `--path`
        // still matches and the diffstat still counts.
        //
        // When hunks were not requested, keep any already stored rather than
        // erasing them — turning `includePatches` off should stop fetching
        // diffs, not delete the ones already paid for.
        const files = store.fileChanges.replaceFileChanges(thread.id, detail.files, {
          preserveStoredPatches: !syncConfig.includePatches,
        });

        store.references.replaceReferences(
          { kind: 'thread', id: thread.id },
          driver.extractReferences(`${detail.title}\n${detail.body ?? ''}`),
        );
        for (const event of events) {
          // Also when the body is now empty. A comment edited down to nothing is
          // the most emphatic way of taking a reference back, and skipping the
          // call would leave the old edges pointing out of text that is gone.
          store.references.replaceReferences(
            { kind: 'event', id: event.id },
            driver.extractReferences(event.body ?? ''),
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

        advance();

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
    } catch (error) {
      if (isAbort(error)) throw error;

      // Step past it rather than stopping. A thread that fails deterministically
      // — a query the source cannot service, a diff too large to store — would
      // otherwise block every later thread in this kind on every future run,
      // because each run re-lists from the same watermark and meets it first.
      // Skipping is only acceptable because the skip is reported, with the
      // watermark needed to retry it via `--since`.
      report.failedThreads.push({
        threadKind,
        number: summary.number,
        updatedAt: summary.updatedAt,
        error: describeError(error),
      });
      advance();
      options.onProgress?.({
        kind: 'thread',
        driver: source.driver,
        key: source.key,
        threadKind,
        number: summary.number,
        title: summary.title,
        outcome: 'failed',
      });
    }
  }

  // The pass reached the end of the stream, so there is nothing left to resume.
  if (options.full && exhausted) {
    store.cursors.clearCursors(source.id, fullCursor);
  }
}

/**
 * Where this kind should start reading.
 *
 * A first sync is bounded to a recent window by default. Reading a source's
 * entire history is the wrong default for a digest tool — it is slow, it can
 * hold a very large repository's summaries in memory at once, and if the run
 * limit trips it stores the *oldest* threads, leaving `activity --since 7d`
 * empty on a store that looks populated.
 */
function resolveSince(
  store: Store,
  source: SourceRow,
  threadKind: ThreadKind,
  syncConfig: SyncConfig,
  options: SyncOptions,
  clock: () => Date,
  report: SourceSyncReport,
): string | null {
  if (options.since !== undefined) return options.since;

  const stored = options.full
    ? store.cursors.getCursorValue(source.id, fullCursorKind(threadKind))
    : store.cursors.getCursorValue(source.id, cursorKind(threadKind));
  if (stored !== null) return stored;

  const bound = syncConfig.firstSyncSince;
  if (bound === null) return null;

  const spec = parseTimeSpec(bound, clock());
  if (spec.kind !== 'instant') {
    throw new ChymeError(
      `sync.firstSyncSince must be a fixed window, not "${bound}".`,
      'Use a relative offset like 90d, a date, or null to read all history.',
    );
  }
  report.firstSyncFrom = spec.at;
  return spec.at;
}
