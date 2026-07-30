import type {
  ExtractedReference,
  ThreadDetail,
  ThreadSummary,
  SourceRef,
  ThreadKind,
  ThreadRef,
} from '../domain/types.js';

export interface ListThreadsOptions {
  /**
   * ISO 8601 UTC watermark. Return every thread whose `updatedAt` is at or
   * after this instant — including threads created long before it. A thread
   * that was opened three weeks ago and got contentious yesterday is exactly
   * the signal this tool exists to catch, so filtering on creation time is
   * always wrong here.
   *
   * Null means "everything", i.e. a first or full sync.
   */
  since: string | null;
  kinds: readonly ThreadKind[];
  signal?: AbortSignal;
}

export interface FetchDetailOptions {
  /** Whether to pull diff hunks. Discourse-only syncs skip them. */
  includePatches: boolean;
  /** Per-file cap. Files over it come back with `patchTruncated: true`. */
  maxPatchBytes: number;
  signal?: AbortSignal;
}

/**
 * The whole of what Chyme needs from a source. Keeping this surface small is
 * what makes a second source type cheap: everything provider-specific — auth,
 * pagination, query languages, reference syntax — lives behind these methods.
 */
export interface SourceDriver {
  /** Stable id used in config and in the store, e.g. 'github'. */
  readonly id: string;

  /**
   * Validate and normalize a user-supplied source key. Throws ConfigError on
   * anything this driver cannot address.
   */
  parseSourceKey(input: string): string;

  /** Human-readable label for a source key, for CLI output. */
  describeSource(key: string): string;

  /**
   * Threads touched at or after the watermark, ascending by `updatedAt`.
   *
   * Ascending order is load-bearing: sync advances its cursor as it consumes
   * the stream, so an interrupted run resumes without a gap.
   */
  listThreadsUpdatedSince(
    source: SourceRef,
    opts: ListThreadsOptions,
  ): AsyncIterable<ThreadSummary>;

  /** Everything said and done inside one thread. */
  fetchThreadDetail(
    source: SourceRef,
    ref: ThreadRef,
    opts: FetchDetailOptions,
  ): Promise<ThreadDetail>;

  /**
   * Find references in free text. Reference syntax is source-specific ("#4412",
   * "owner/repo#12", a bare sha), so parsing belongs to the driver even though
   * the resulting edges are stored in a source-agnostic table.
   */
  extractReferences(text: string): ExtractedReference[];
}

/**
 * Builds a driver from whatever credentials the config supplied for it.
 * Implementations validate their own credential shape and throw ConfigError
 * with an actionable hint when it is missing or wrong.
 */
export interface DriverFactory {
  readonly id: string;

  /**
   * The thread kinds this driver can actually service today.
   *
   * Declared rather than assumed, because `ThreadKind` is an open vocabulary: a
   * ticket tracker would offer `'ticket'`, a chat source `'channel_thread'`, and
   * neither would offer `'pull_request'`. It also keeps us honest about kinds a
   * driver knows of but has not implemented — those are left out here, so the
   * config is rejected with an explanation instead of failing mid-sync.
   */
  readonly supportedKinds: readonly ThreadKind[];

  create(credentials: Record<string, unknown> | undefined): SourceDriver;

  /**
   * Validate and normalize a source key without building a driver.
   *
   * Deciding whether "owner/repo" is well-formed needs no credentials, and
   * requiring them would mean you could not write down which repositories you
   * follow before you had a token — exactly backwards for a config file.
   */
  parseSourceKey(input: string): string;
}
