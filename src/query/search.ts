import type {
  ActorRow,
  EventRow,
  ProjectRow,
  SearchEntityKind,
  SearchHit,
  SourceRow,
  Store,
  ThreadRow,
} from '../store/index.js';
import { createEventLookup } from './events.js';
import { threadRefOf } from './refs.js';

/**
 * Search, with the hits resolved back to what they are.
 *
 * The index answers in ids; a hit is only presentable once it carries the
 * thread it belongs to and a reference the reader can hand straight back to
 * `chyme thread`. The store's ranking is preserved untouched — reordering a
 * result set by anything else here would make `score` a lie.
 */

/** Matches the store's own default. Passed explicitly so `limited` can be honest. */
export const DEFAULT_SEARCH_LIMIT = 50;

export interface SearchOptions {
  text: string;
  /** Scope to one project. Omit to search every project in the store. */
  project?: ProjectRow;
  threadId?: number;
  since?: string;
  /** Exclusive, matching every other window in Chyme. */
  until?: string;
  kinds?: readonly SearchEntityKind[];
  limit?: number;
}

export interface ResolvedHit {
  hit: SearchHit;
  ref: string;
  project: ProjectRow;
  source: SourceRow;
  thread: ThreadRow;
  /** The event whose body matched, or null when the thread's own text did. */
  event: EventRow | null;
  /** Who wrote the matching text: the event's actor, or the thread's author. */
  actor: ActorRow | null;
}

export interface SearchResults {
  /** The text as typed, for echoing back in a header. */
  text: string;
  hits: ResolvedHit[];
  limit: number;
  /** The limit was reached, so there may be more. Say so; never imply completeness. */
  limited: boolean;
  /** Hits whose thread has since left the store. Counted rather than dropped in silence. */
  unresolved: number;
}

export function querySearch(store: Store, options: SearchOptions): SearchResults {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const hits = store.search.search({
    text: options.text,
    ...(options.project ? { projectId: options.project.id } : {}),
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.kinds ? { kinds: options.kinds } : {}),
    limit,
  });

  const lookup = createEventLookup(store);
  const threads = new Map<number, ThreadRow | null>();
  const sources = new Map<number, SourceRow | null>();
  const projects = new Map<number, ProjectRow | null>();
  const actors = new Map<number, ActorRow | null>();

  const resolved: ResolvedHit[] = [];
  let unresolved = 0;

  for (const hit of hits) {
    if (!threads.has(hit.threadId)) threads.set(hit.threadId, store.threads.getThread(hit.threadId));
    const thread = threads.get(hit.threadId) ?? null;
    if (!thread) {
      unresolved += 1;
      continue;
    }

    if (!sources.has(thread.sourceId)) {
      sources.set(thread.sourceId, store.sources.getSource(thread.sourceId));
    }
    const source = sources.get(thread.sourceId) ?? null;
    if (!source) {
      unresolved += 1;
      continue;
    }

    if (!projects.has(source.projectId)) {
      projects.set(source.projectId, store.projects.getProject(source.projectId));
    }
    const project = projects.get(source.projectId) ?? null;
    if (!project) {
      unresolved += 1;
      continue;
    }

    const event = hit.entityKind === 'event' ? lookup.find(hit.entityId) : null;
    const actorId = event ? event.actorId : thread.authorId;
    if (actorId !== null && !actors.has(actorId)) {
      actors.set(actorId, store.actors.getActor(actorId));
    }

    resolved.push({
      hit,
      ref: threadRefOf(project, source, thread),
      project,
      source,
      thread,
      event,
      actor: actorId === null ? null : (actors.get(actorId) ?? null),
    });
  }

  return {
    text: options.text,
    hits: resolved,
    limit,
    limited: hits.length >= limit,
    unresolved,
  };
}
