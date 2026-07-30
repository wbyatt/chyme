/**
 * Forge-neutral domain shapes.
 *
 * Nothing in this file may know what GitHub is. Drivers map their own payloads
 * into these types; the store, sync engine, query layer, and renderers only
 * ever see these. Adding a forge means adding a mapper, not changing this file.
 */

/** The kind of discussion aggregate a thread represents. */
export type ThreadKind = 'pull_request' | 'issue' | 'discussion';

export const THREAD_KINDS: readonly ThreadKind[] = ['pull_request', 'issue', 'discussion'];

/**
 * Lifecycle state. Deliberately orthogonal to `isDraft` — a draft PR is still
 * open, and collapsing the two loses the distinction between "not ready" and
 * "not started".
 */
export type ThreadState = 'open' | 'closed' | 'merged';

/**
 * What happened inside a thread. This is the discourse record: the ordered log
 * of everything a reader would have seen had they been watching.
 */
export type EventKind =
  /** Top-level discussion comment on the thread. */
  | 'comment'
  /** A submitted review (approval, change request, or plain comment). */
  | 'review'
  /** An inline comment anchored to a file and line. */
  | 'review_comment'
  /** A commit that became part of the thread's proposed change. */
  | 'commit'
  /** Opened, closed, merged, reopened, marked ready for review. */
  | 'state_change'
  /** A label was added or removed. */
  | 'label'
  /** The title changed. */
  | 'rename';

export const EVENT_KINDS: readonly EventKind[] = [
  'comment',
  'review',
  'review_comment',
  'commit',
  'state_change',
  'label',
  'rename',
];

/** How a file was touched by a change. */
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed';

/**
 * A participant. `isBot` matters: bot traffic is the bulk of the volume in an
 * active repo and the least of the signal, so it must be filterable rather than
 * silently dropped at ingest.
 */
export interface ForgeActor {
  /** Stable identifier within the source forge. */
  externalId: string;
  /** Login/handle, e.g. a GitHub username. */
  handle: string;
  displayName: string | null;
  isBot: boolean;
}

/**
 * Points at a source without saying what kind of source it is. `key` is opaque
 * to everything except the driver that issued it — for GitHub it happens to be
 * "owner/repo", but no caller may assume that.
 */
export interface SourceRef {
  /** Driver id, e.g. 'github'. */
  driver: string;
  /** Driver-interpreted source identifier. */
  key: string;
}

/** Locates one thread within a source. */
export interface ThreadRef {
  kind: ThreadKind;
  number: number;
}

/**
 * Enough of a thread to decide whether it is worth fetching in full. Returned
 * by the cheap listing pass during sync.
 */
export interface ForgeThreadSummary {
  externalId: string;
  kind: ThreadKind;
  number: number;
  title: string;
  state: ThreadState;
  isDraft: boolean;
  author: ForgeActor | null;
  url: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC. Moves when anything in the thread changes. */
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  labels: string[];
  /** The driver's untouched payload, retained so the schema can evolve without a resync. */
  raw: unknown;
}

/** One thing that happened in a thread, at a point in time. */
export interface ForgeEvent {
  /** Stable identifier within the source forge; used for idempotent upsert. */
  externalId: string;
  kind: EventKind;
  actor: ForgeActor | null;
  /** ISO 8601 UTC. */
  createdAt: string;
  body: string | null;
  /** Set for inline review comments. */
  path: string | null;
  /** Set for inline review comments, when the forge reports a line. */
  line: number | null;
  /**
   * Kind-specific fields worth rendering without reaching into `raw`:
   * review state, label name, commit sha, old/new title.
   */
  detail: Record<string, unknown> | null;
  raw: unknown;
}

/** A single file's participation in a change. */
export interface ForgeFileChange {
  path: string;
  /** Set when the file was renamed or copied from somewhere else. */
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunk text. Null when unavailable or over budget. */
  patch: string | null;
  /**
   * True when the forge withheld the patch or it exceeded the configured cap.
   * Never let a missing patch read as an empty one.
   */
  patchTruncated: boolean;
}

/** A thread and everything said and done inside it. */
export interface ForgeThreadDetail extends ForgeThreadSummary {
  /** The opening description. */
  body: string | null;
  events: ForgeEvent[];
  files: ForgeFileChange[];
}

/**
 * A reference discovered in free text. Resolution is deliberately late-bound
 * and optional: an unresolvable "PROJ-88" still records that this thread points
 * at a ticket, and becomes resolvable the day a Jira driver exists.
 */
export interface ExtractedReference {
  /** Open vocabulary: 'thread' | 'commit' | 'url' | 'ticket' | driver-specific. */
  refKind: string;
  /** The literal matched text, e.g. "#4412", "PROJ-88", a 40-char sha, a URL. */
  refRaw: string;
  /**
   * Driver-scoped hint at what was pointed to, when the syntax makes it
   * unambiguous. Null means "we saw a reference but did not resolve it".
   */
  hint: Record<string, unknown> | null;
}
