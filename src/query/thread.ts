import type { EventKind } from '../domain/types.js';
import type {
  ActorRow,
  EventRow,
  FileChangeSummary,
  ProjectRow,
  ReferenceRow,
  SourceRow,
  Store,
  ThreadRow,
} from '../store/index.js';
import { createEventLookup } from './events.js';
import { threadRefOf, type ResolvedThreadRef } from './refs.js';

/**
 * One thread, assembled whole.
 *
 * The reverse reference edge is here for the same reason the forward one is:
 * "what points at this" is how a follow-up fix, a revert, or the issue that
 * finally explains a PR gets found, and none of those are reachable from the
 * thread's own text.
 */

export interface ThreadEvent {
  event: EventRow;
  actor: ActorRow | null;
}

export interface ReferenceTarget {
  thread: ThreadRow;
  source: SourceRow;
  project: ProjectRow;
  ref: string;
}

export interface OutgoingReference {
  reference: ReferenceRow;
  /** The event whose text carried it, or null when it came from the thread body. */
  fromEvent: EventRow | null;
  /** Set only once a resolution pass has worked out what the text pointed at. */
  target: ReferenceTarget | null;
}

export interface IncomingReference {
  reference: ReferenceRow;
  /** Null when the pointing entity has since been deleted from the store. */
  from: ReferenceTarget | null;
  /** Set when the pointer was in an event rather than a thread body. */
  fromEvent: EventRow | null;
  fromActor: ActorRow | null;
}

export interface ThreadViewOptions {
  /** Comments, reviews and inline review comments. Default true — this is the product. */
  includeComments?: boolean;
  /** Commit messages. Default true; they are often the most considered text in the thread. */
  includeCommits?: boolean;
  /** Diff hunks. Default false: they dominate the byte count and are rarely the answer. */
  includeDiffs?: boolean;
}

export interface ThreadView {
  ref: string;
  project: ProjectRow;
  source: SourceRow;
  thread: ThreadRow;
  author: ActorRow | null;
  /** Chronological. */
  events: ThreadEvent[];
  files: ThreadFile[];
  /** False when patches were not requested; every `patch` is then null. */
  diffsIncluded: boolean;
  referencesOut: OutgoingReference[];
  referencesIn: IncomingReference[];
  totals: ThreadTotals;
  /** Events the options withheld, by kind. Never let a filtered view read as a whole one. */
  omittedEvents: Partial<Record<EventKind, number>>;
}

export interface ThreadFile extends FileChangeSummary {
  /** Null when diffs were not requested, or when the source withheld the hunk. */
  patch: string | null;
}

/**
 * The thread as it stands, never the view of it. Every count here is over the
 * whole thread — what the options withheld is named in `omittedEvents` — so a
 * filtered read cannot be mistaken for a smaller thread.
 */
export interface ThreadTotals {
  events: number;
  files: number;
  additions: number;
  deletions: number;
  participants: number;
}

/** The kinds that carry discussion, as opposed to the thread's own spine. */
const DISCUSSION_KINDS: readonly EventKind[] = ['comment', 'review', 'review_comment'];

export function queryThread(
  store: Store,
  target: ResolvedThreadRef,
  options: ThreadViewOptions = {},
): ThreadView {
  const { project, source, thread } = target;
  const includeComments = options.includeComments ?? true;
  const includeCommits = options.includeCommits ?? true;
  const includeDiffs = options.includeDiffs ?? false;

  const actors = actorCache(store);
  const lookup = createEventLookup(store);

  const all = store.events.listEventsForThread(thread.id);
  const omittedEvents: Partial<Record<EventKind, number>> = {};
  const events: ThreadEvent[] = [];

  for (const event of all) {
    // State changes, labels and renames are kept whatever the options say: they
    // are a handful of bytes each and they are the thread's spine.
    const wanted =
      (includeComments || !DISCUSSION_KINDS.includes(event.kind)) &&
      (includeCommits || event.kind !== 'commit');
    if (!wanted) {
      omittedEvents[event.kind] = (omittedEvents[event.kind] ?? 0) + 1;
      continue;
    }
    events.push({
      event,
      actor: event.actorId === null ? null : actors(event.actorId),
    });
  }

  const files: ThreadFile[] = includeDiffs
    ? store.fileChanges.listFileChanges(thread.id)
    : store.fileChanges
        .listFileChangeSummaries(thread.id)
        .map((file) => ({ ...file, patch: null }));

  const threadTargets = targetCache(store);
  const targetOf = (reference: ReferenceRow): ReferenceTarget | null =>
    reference.toKind === 'thread' && reference.toId !== null
      ? threadTargets(reference.toId)
      : null;

  const referencesOut: OutgoingReference[] = store.references
    .listReferencesFrom({ kind: 'thread', id: thread.id })
    .map((reference) => ({ reference, fromEvent: null, target: targetOf(reference) }));

  // Only the events actually shown contribute their references: claiming an
  // edge from a comment the reader was not given is claiming something they
  // cannot check.
  for (const { event } of events) {
    for (const reference of store.references.listReferencesFrom({ kind: 'event', id: event.id })) {
      referencesOut.push({ reference, fromEvent: event, target: targetOf(reference) });
    }
  }

  const referencesIn: IncomingReference[] = store.references
    .listReferencesTo('thread', thread.id)
    .map((reference) => {
      const fromEvent = reference.from.kind === 'event' ? lookup.find(reference.from.id) : null;
      const fromThreadId =
        reference.from.kind === 'thread' ? reference.from.id : (fromEvent?.threadId ?? null);
      const from = fromThreadId === null ? null : threadTargets(fromThreadId);
      // Who pointed at us: the commenter if it came from a comment, otherwise
      // the author of the thread whose description carried it.
      const fromActor =
        fromEvent?.actorId != null
          ? actors(fromEvent.actorId)
          : from?.thread.authorId != null
            ? actors(from.thread.authorId)
            : null;
      return { reference, from, fromEvent, fromActor };
    });

  // Over every event, not the ones the options kept — the same basis as the
  // event total beside it. Counting participants from the filtered stream made
  // `--no-comments` print "6 events · 1 participant" for a thread two people
  // argued in, which reads as a fact about the thread rather than about the
  // view of it.
  const participants = new Set<number>();
  if (thread.authorId !== null) participants.add(thread.authorId);
  for (const event of all) {
    if (event.actorId !== null) participants.add(event.actorId);
  }

  return {
    ref: threadRefOf(project, source, thread),
    project,
    source,
    thread,
    author: thread.authorId === null ? null : actors(thread.authorId),
    events,
    files,
    diffsIncluded: includeDiffs,
    referencesOut,
    referencesIn,
    totals: {
      // The whole event count, not the filtered one: the reader needs to know
      // what exists, not only what they asked for.
      events: all.length,
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      participants: participants.size,
    },
    omittedEvents,
  };
}

function actorCache(store: Store): (id: number) => ActorRow | null {
  const cache = new Map<number, ActorRow | null>();
  return (id) => {
    if (!cache.has(id)) cache.set(id, store.actors.getActor(id));
    return cache.get(id) ?? null;
  };
}

/** Both directions of the reference walk return to the same threads. */
function targetCache(store: Store): (threadId: number) => ReferenceTarget | null {
  const cache = new Map<number, ReferenceTarget | null>();
  return (threadId) => {
    if (!cache.has(threadId)) cache.set(threadId, resolveThreadTarget(store, threadId));
    return cache.get(threadId) ?? null;
  };
}

function resolveThreadTarget(store: Store, threadId: number): ReferenceTarget | null {
  const thread = store.threads.getThread(threadId);
  if (!thread) return null;
  const source = store.sources.getSource(thread.sourceId);
  if (!source) return null;
  // A reference can cross projects, so the project comes from the source rather
  // than from whichever project the caller happens to be reading.
  const project = store.projects.getProject(source.projectId);
  if (!project) return null;
  return { thread, source, project, ref: threadRefOf(project, source, thread) };
}
