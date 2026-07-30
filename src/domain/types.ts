/**
 * Source-neutral domain shapes.
 *
 * Nothing in this file may know what GitHub — or git — is. Drivers map their own
 * payloads into these types; the store, sync engine, query layer, and renderers
 * only ever see these.
 *
 * The abstraction is deliberately pitched at *a thread of discourse*, not at a
 * pull request. Git forges are the only sources implemented today, but the shape
 * is meant to accommodate a Jira ticket with its comment history, a Slack thread,
 * or a Notion document with its revisions — none of which have branches, diffs,
 * or reviews. That is why the vocabularies below are open: a source may name
 * kinds this file has never heard of, and everything downstream carries them
 * through rather than dropping them.
 */

/**
 * The kind of aggregate a thread represents.
 *
 * An OPEN vocabulary. The constants below are what today's drivers emit; a Jira
 * driver would add `'ticket'` and a Slack driver `'channel_thread'` without
 * touching this file. Code that switches on a kind must therefore have a default
 * branch — an unrecognized kind is a source we do not know well yet, never an
 * error and never something to silently discard.
 */
export type KnownThreadKind = 'pull_request' | 'issue' | 'discussion';

export type ThreadKind = KnownThreadKind | (string & {});

export const KNOWN_THREAD_KINDS: readonly KnownThreadKind[] = [
  'pull_request',
  'issue',
  'discussion',
];

/**
 * Lifecycle state, also an open vocabulary — `'merged'` is meaningless for a
 * Notion page and a Jira workflow has states no forge does.
 *
 * Deliberately orthogonal to `isDraft`: a draft pull request is still open, and
 * collapsing the two loses the distinction between "not ready" and "not started".
 */
export type KnownThreadState = 'open' | 'closed' | 'merged';

export type ThreadState = KnownThreadState | (string & {});

export const KNOWN_THREAD_STATES: readonly KnownThreadState[] = ['open', 'closed', 'merged'];

/**
 * What happened inside a thread. This is the discourse record: the ordered log
 * of everything a reader would have seen had they been watching.
 *
 * Open, for the same reason as the others. Several of the known kinds are git
 * vocabulary and simply will not occur for other sources, which is fine — a
 * source emits the kinds it has.
 */
export type KnownEventKind =
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

export type EventKind = KnownEventKind | (string & {});

export const KNOWN_EVENT_KINDS: readonly KnownEventKind[] = [
  'comment',
  'review',
  'review_comment',
  'commit',
  'state_change',
  'label',
  'rename',
];

/**
 * Order event kinds for display: the known ones in their canonical order, then
 * anything a source invented, alphabetically.
 *
 * Callers must use this rather than iterating `KNOWN_EVENT_KINDS` directly —
 * doing that would silently omit a new source's events from every count and
 * summary, which is exactly the failure mode an open vocabulary invites.
 */
export function orderEventKinds(kinds: Iterable<EventKind>): EventKind[] {
  const present = [...new Set(kinds)];
  const rank = (kind: EventKind): number => {
    const index = KNOWN_EVENT_KINDS.indexOf(kind as KnownEventKind);
    return index < 0 ? KNOWN_EVENT_KINDS.length : index;
  };
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

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
export interface SourceActor {
  /** Stable identifier within the source. */
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
export interface ThreadSummary {
  externalId: string;
  kind: ThreadKind;
  number: number;
  title: string;
  state: ThreadState;
  isDraft: boolean;
  author: SourceActor | null;
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
export interface SourceEvent {
  /** Stable identifier within the source; used for idempotent upsert. */
  externalId: string;
  kind: EventKind;
  actor: SourceActor | null;
  /** ISO 8601 UTC. */
  createdAt: string;
  body: string | null;
  /** Set for inline review comments. */
  path: string | null;
  /** Set for inline review comments, when the source reports a line. */
  line: number | null;
  /**
   * Kind-specific fields worth rendering without reaching into `raw`:
   * review state, label name, commit sha, old/new title.
   */
  detail: Record<string, unknown> | null;
  raw: unknown;
}

/** A single file's participation in a change. */
export interface FileChange {
  path: string;
  /** Set when the file was renamed or copied from somewhere else. */
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunk text. Null when unavailable or over budget. */
  patch: string | null;
  /**
   * True when the source withheld the patch or it exceeded the configured cap.
   * Never let a missing patch read as an empty one.
   */
  patchTruncated: boolean;
}

/** A thread and everything said and done inside it. */
export interface ThreadDetail extends ThreadSummary {
  /** The opening description. */
  body: string | null;
  events: SourceEvent[];
  files: FileChange[];
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
