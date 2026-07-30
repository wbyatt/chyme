import { orderEventKinds, type EventKind, type ThreadKind } from '../domain/types.js';
import type { ActorRow, EventRow, ProjectRow, SourceRow, Store, ThreadRow } from '../store/index.js';
import { threadRefOf } from './refs.js';
import type { ActivityWindow } from './window.js';

/**
 * "What moved in this window", enumerated.
 *
 * Every thread with activity in the window is returned — no relevance ranking,
 * no cap. A digest that silently dropped a thread is worse than no digest,
 * because it is believed, so bounding happens in the renderer where it can be
 * declared. What this layer does drop, it counts (see `ActivityExclusions`).
 */

export type ThreadDisposition =
  /** Created inside the window. */
  | 'new'
  /** Created before it and moved inside it — usually the more interesting case. */
  | 'ongoing';

export interface ActivityFilters {
  /** Actor handles, matched case-insensitively against the author and the in-window actors. */
  authors?: readonly string[];
  /** Source keys, e.g. `acme/api`. */
  sourceKeys?: readonly string[];
  /** Path prefixes, matched against changed files and inline comment paths. */
  paths?: readonly string[];
  kinds?: readonly ThreadKind[];
  /**
   * Let bot activity pull a thread into the result. Off by default: bot traffic
   * is most of the volume and least of the signal. Bots' events are still shown
   * on threads included for other reasons — once a thread is worth reading, its
   * record is shown whole.
   */
  includeBots?: boolean;
}

/** What a full `thread` expansion would cost, so an agent can plan what to open. */
export interface ThreadSizeHint {
  /** Metadata, opening body and every event body. */
  discussionBytes: number;
  /** Every stored patch. */
  diffBytes: number;
  totalBytes: number;
}

export interface ThreadActivity {
  ref: string;
  thread: ThreadRow;
  source: SourceRow;
  author: ActorRow | null;
  disposition: ThreadDisposition;
  /** In-window events, chronological. Includes bots'. */
  events: EventRow[];
  eventCounts: Partial<Record<EventKind, number>>;
  /** Distinct in-window actors, plus the author of a thread opened in the window. */
  participants: ActorRow[];
  /** The most recent in-window timestamp; the sort key. */
  lastActivityAt: string;
  diffstat: Diffstat;
  size: ThreadSizeHint;
}

export interface Diffstat {
  files: number;
  additions: number;
  deletions: number;
}

export interface ActivityTotals {
  threads: number;
  newThreads: number;
  ongoingThreads: number;
  events: number;
  eventsByKind: Partial<Record<EventKind, number>>;
  participants: number;
  sources: number;
}

/**
 * Threads that moved in the window and were left out anyway. Reported so the
 * caller can say so; an unexplained gap between "12 threads moved" and "8 shown"
 * is the failure this whole tool exists to avoid.
 */
export interface ActivityExclusions {
  byFilter: number;
  botOnly: number;
}

export interface ActivityResult {
  project: ProjectRow;
  window: ActivityWindow;
  /** As applied, including the resolved bot default — so output can state it. */
  filters: ResolvedActivityFilters;
  /** Most recent activity first. */
  threads: ThreadActivity[];
  totals: ActivityTotals;
  excluded: ActivityExclusions;
}

export interface ResolvedActivityFilters {
  authors: readonly string[];
  sourceKeys: readonly string[];
  paths: readonly string[];
  kinds: readonly ThreadKind[];
  includeBots: boolean;
}

/**
 * Rendering overhead the size hint has to account for: a thread expansion is not
 * just its stored text, it is that text under per-event and per-file headers.
 * Approximate on purpose — the hint exists to rank "cheap" against "expensive",
 * not to predict a byte count.
 */
const THREAD_OVERHEAD_BYTES = 256;
const EVENT_OVERHEAD_BYTES = 64;
const FILE_OVERHEAD_BYTES = 48;

interface CandidateRow {
  id: number;
  events: number;
  eventBytes: number;
  files: number;
  additions: number;
  deletions: number;
  patchBytes: number;
  bodyBytes: number;
}

/**
 * Candidate threads, with the aggregates the size hint needs.
 *
 * The predicate is a union of three signals rather than `updated_at` alone: a
 * thread commented on inside the window but touched again after it has an
 * `updated_at` past the window's end, and enumerating by that column would drop
 * it. `length(cast(x AS BLOB))` is byte length; `length()` on text counts
 * characters, which would under-report every non-ASCII body.
 */
const CANDIDATES = `SELECT t.id AS id,
    (SELECT count(*) FROM event e WHERE e.thread_id = t.id) AS events,
    (SELECT coalesce(sum(length(cast(coalesce(e.body, '') AS BLOB))), 0)
       FROM event e WHERE e.thread_id = t.id) AS event_bytes,
    (SELECT count(*) FROM file_change f WHERE f.thread_id = t.id) AS files,
    (SELECT coalesce(sum(f.additions), 0) FROM file_change f WHERE f.thread_id = t.id) AS additions,
    (SELECT coalesce(sum(f.deletions), 0) FROM file_change f WHERE f.thread_id = t.id) AS deletions,
    (SELECT coalesce(sum(length(cast(coalesce(f.patch, '') AS BLOB))), 0)
       FROM file_change f WHERE f.thread_id = t.id) AS patch_bytes,
    length(cast(coalesce(t.body, '') AS BLOB)) AS body_bytes
  FROM thread t
  WHERE t.source_id IN (SELECT id FROM source WHERE project_id = ?)
    AND ((t.created_at >= ? AND t.created_at < ?)
      OR (t.updated_at >= ? AND t.updated_at < ?)
      OR EXISTS (SELECT 1 FROM event e
                 WHERE e.thread_id = t.id AND e.created_at >= ? AND e.created_at < ?))`;

function number(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

function selectCandidates(store: Store, projectId: number, window: ActivityWindow): CandidateRow[] {
  const { since, until } = window;
  return store.db
    .prepare(CANDIDATES)
    .all(projectId, since, until, since, until, since, until)
    .map((row) => ({
      id: number(row['id']),
      events: number(row['events']),
      eventBytes: number(row['event_bytes']),
      files: number(row['files']),
      additions: number(row['additions']),
      deletions: number(row['deletions']),
      patchBytes: number(row['patch_bytes']),
      bodyBytes: number(row['body_bytes']),
    }));
}

export function queryActivity(
  store: Store,
  project: ProjectRow,
  window: ActivityWindow,
  filters: ActivityFilters = {},
): ActivityResult {
  const resolved: ResolvedActivityFilters = {
    authors: filters.authors ?? [],
    sourceKeys: filters.sourceKeys ?? [],
    paths: filters.paths ?? [],
    kinds: filters.kinds ?? [],
    includeBots: filters.includeBots ?? false,
  };

  const sources = new Map(store.sources.listSources(project.id).map((row) => [row.id, row]));
  const actors = actorCache(store);
  const matches = createMatcher(store, resolved, actors);
  const inWindow = (at: string): boolean => at >= window.since && at < window.until;

  // One query for the whole window rather than one per thread: this is the
  // single largest read in the command and it is already indexed on created_at.
  const eventsByThread = new Map<number, EventRow[]>();
  for (const event of store.events.listEventsBetween(project.id, window.since, window.until)) {
    const list = eventsByThread.get(event.threadId);
    if (list) list.push(event);
    else eventsByThread.set(event.threadId, [event]);
  }

  const threads: ThreadActivity[] = [];
  const excluded: ActivityExclusions = { byFilter: 0, botOnly: 0 };

  for (const candidate of selectCandidates(store, project.id, window)) {
    const thread = store.threads.getThread(candidate.id);
    if (!thread) continue;
    const source = sources.get(thread.sourceId) ?? store.sources.getSource(thread.sourceId);
    if (!source) continue;

    const events = eventsByThread.get(thread.id) ?? [];
    const author = thread.authorId === null ? null : actors(thread.authorId);
    const createdInWindow = inWindow(thread.createdAt);

    if (!matches({ thread, source, author, events })) {
      excluded.byFilter += 1;
      continue;
    }

    if (!resolved.includeBots && !hasHumanSignal(events, actors, createdInWindow, author)) {
      excluded.botOnly += 1;
      continue;
    }

    const participants = collectParticipants(events, actors, createdInWindow ? author : null);
    const stamps = events.map((event) => event.createdAt);
    if (createdInWindow) stamps.push(thread.createdAt);
    if (inWindow(thread.updatedAt)) stamps.push(thread.updatedAt);

    threads.push({
      ref: threadRefOf(project, source, thread),
      thread,
      source,
      author,
      disposition: createdInWindow ? 'new' : 'ongoing',
      events,
      eventCounts: countByKind(events),
      participants,
      // A thread can qualify on `updated_at` alone — a metadata edit with no
      // event of its own — in which case that is the only timestamp there is.
      lastActivityAt: stamps.reduce(
        (latest, at) => (at > latest ? at : latest),
        stamps[0] ?? thread.updatedAt,
      ),
      diffstat: {
        files: candidate.files,
        additions: candidate.additions,
        deletions: candidate.deletions,
      },
      size: sizeHint(candidate),
    });
  }

  threads.sort((left, right) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
    }
    return right.thread.id - left.thread.id;
  });

  return {
    project,
    window,
    filters: resolved,
    threads,
    totals: totalsOf(threads),
    excluded,
  };
}

function sizeHint(candidate: CandidateRow): ThreadSizeHint {
  const discussionBytes =
    THREAD_OVERHEAD_BYTES +
    candidate.bodyBytes +
    candidate.eventBytes +
    candidate.events * EVENT_OVERHEAD_BYTES;
  const diffBytes = candidate.patchBytes + candidate.files * FILE_OVERHEAD_BYTES;
  return { discussionBytes, diffBytes, totalBytes: discussionBytes + diffBytes };
}

function actorCache(store: Store): (id: number) => ActorRow | null {
  const cache = new Map<number, ActorRow | null>();
  return (id) => {
    if (!cache.has(id)) cache.set(id, store.actors.getActor(id));
    return cache.get(id) ?? null;
  };
}

function countByKind(events: readonly EventRow[]): Partial<Record<EventKind, number>> {
  const counts: Partial<Record<EventKind, number>> = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

function collectParticipants(
  events: readonly EventRow[],
  actors: (id: number) => ActorRow | null,
  author: ActorRow | null,
): ActorRow[] {
  const byId = new Map<number, ActorRow>();
  if (author) byId.set(author.id, author);
  for (const event of events) {
    if (event.actorId === null) continue;
    const actor = actors(event.actorId);
    if (actor) byId.set(actor.id, actor);
  }
  return [...byId.values()].sort((left, right) => left.handle.localeCompare(right.handle));
}

/**
 * Did anything happen here that was not a bot?
 *
 * A thread that qualified on `updated_at` with no events at all counts: the
 * change cannot be attributed to anyone, and dropping it would mean dropping a
 * real edit on the grounds of a guess.
 */
function hasHumanSignal(
  events: readonly EventRow[],
  actors: (id: number) => ActorRow | null,
  createdInWindow: boolean,
  author: ActorRow | null,
): boolean {
  if (events.length === 0) return true;
  if (createdInWindow && !(author?.isBot ?? false)) return true;
  return events.some((event) => {
    if (event.actorId === null) return true;
    return !(actors(event.actorId)?.isBot ?? false);
  });
}

interface FilterSubject {
  thread: ThreadRow;
  source: SourceRow;
  author: ActorRow | null;
  events: readonly EventRow[];
}

function createMatcher(
  store: Store,
  filters: ResolvedActivityFilters,
  actors: (id: number) => ActorRow | null,
): (subject: FilterSubject) => boolean {
  const wantedAuthors = new Set(filters.authors.map((handle) => handle.toLowerCase()));
  const wantedSources = new Set(filters.sourceKeys.map((key) => key.toLowerCase()));
  const wantedKinds = new Set(filters.kinds);

  return ({ thread, source, author, events }) => {
    if (wantedKinds.size > 0 && !wantedKinds.has(thread.kind)) return false;
    if (wantedSources.size > 0 && !wantedSources.has(source.key.toLowerCase())) return false;

    if (wantedAuthors.size > 0) {
      // Either they opened it or they said something in the window. "What has
      // Kai been working on" means both, and the second is usually the larger
      // half of the answer.
      const handles = new Set<string>();
      if (author) handles.add(author.handle.toLowerCase());
      for (const event of events) {
        if (event.actorId === null) continue;
        const actor = actors(event.actorId);
        if (actor) handles.add(actor.handle.toLowerCase());
      }
      if (![...wantedAuthors].some((handle) => handles.has(handle))) return false;
    }

    if (filters.paths.length > 0) {
      // Only loaded when a path filter is set: for every other query the file
      // list is a per-thread read that answers nothing.
      const paths: string[] = [];
      for (const file of store.fileChanges.listFileChangeSummaries(thread.id)) {
        paths.push(file.path);
        // A rename's old path is how someone who remembers the file will ask.
        if (file.previousPath) paths.push(file.previousPath);
      }
      for (const event of events) {
        if (event.path) paths.push(event.path);
      }
      // Plain prefix matching: `src/billing` finds `src/billing/rates.ts` and
      // `src/billing.ts` alike, which is what someone typing a directory means.
      if (!paths.some((path) => filters.paths.some((prefix) => path.startsWith(prefix)))) {
        return false;
      }
    }

    return true;
  };
}

function totalsOf(threads: readonly ThreadActivity[]): ActivityTotals {
  const eventsByKind: Partial<Record<EventKind, number>> = {};
  const participants = new Set<number>();
  const sources = new Set<number>();
  let events = 0;
  let newThreads = 0;

  for (const activity of threads) {
    sources.add(activity.source.id);
    if (activity.disposition === 'new') newThreads += 1;
    events += activity.events.length;
    // Over the kinds actually present, not a fixed list: a source-specific kind
    // must still be counted, or the totals quietly disagree with the threads.
    for (const kind of orderEventKinds(Object.keys(activity.eventCounts))) {
      const count = activity.eventCounts[kind];
      if (count) eventsByKind[kind] = (eventsByKind[kind] ?? 0) + count;
    }
    for (const actor of activity.participants) participants.add(actor.id);
  }

  return {
    threads: threads.length,
    newThreads,
    ongoingThreads: threads.length - newThreads,
    events,
    eventsByKind,
    participants: participants.size,
    sources: sources.size,
  };
}
