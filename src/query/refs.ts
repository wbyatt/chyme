import type { ThreadKind } from '../domain/types.js';
import type { ProjectRow, SourceRow, Store, ThreadRow } from '../store/index.js';
import { ChymeError, NotFoundError } from '../util/errors.js';

/**
 * Stable thread references: `<project-slug>/<source-key>#<number>`.
 *
 * A reference is written into a digest, read back by a human a week later, and
 * handed to `chyme thread` verbatim, so it is built from the three things that
 * do not change — project slug, source key, thread number — rather than from a
 * row id, which is local to one machine's store.
 */

const HINT = 'Write it as project/source#number, e.g. platform/acme/api#412.';

const NUMBER = /^\d+$/;

export interface ThreadRefParts {
  /** Null when the reference named no project, e.g. `#412` or `412`. */
  projectSlug: string | null;
  /** Null when the reference named no source, e.g. `platform#412`. */
  sourceKey: string | null;
  number: number;
}

export function formatThreadRef(projectSlug: string, sourceKey: string, number: number): string {
  return `${projectSlug}/${sourceKey}#${number}`;
}

export function threadRefOf(project: ProjectRow, source: SourceRow, thread: ThreadRow): string {
  return formatThreadRef(project.slug, source.key, thread.number);
}

/**
 * Parsed from the right, because the source key has slashes of its own: in
 * `platform/acme/api#412` only the last `#` and the first `/` separate anything.
 */
export function parseThreadRef(input: string): ThreadRefParts {
  const value = input.trim();
  if (value === '') {
    throw new ChymeError('Empty thread reference.', HINT);
  }

  const hash = value.lastIndexOf('#');
  const numberText = hash === -1 ? value : value.slice(hash + 1);
  if (!NUMBER.test(numberText)) {
    throw new ChymeError(`"${input}" is not a thread reference.`, HINT);
  }

  const number = Number(numberText);
  if (number === 0) {
    throw new ChymeError('Thread numbers start at 1.', HINT);
  }

  const prefix = hash === -1 ? '' : value.slice(0, hash);
  if (prefix === '') return { projectSlug: null, sourceKey: null, number };

  const slash = prefix.indexOf('/');
  if (slash === -1) return { projectSlug: prefix, sourceKey: null, number };

  const projectSlug = prefix.slice(0, slash);
  const sourceKey = prefix.slice(slash + 1);
  if (projectSlug === '' || sourceKey === '') {
    throw new ChymeError(`"${input}" is not a thread reference.`, HINT);
  }
  return { projectSlug, sourceKey, number };
}

export interface ResolveThreadRefOptions {
  /** The project to look in when the reference does not name one itself. */
  projectSlug?: string;
  /** Narrows a number that exists as both an issue and a pull request. */
  kind?: ThreadKind;
}

export interface ResolvedThreadRef {
  /** The canonical, fully qualified form — what a digest should quote. */
  ref: string;
  project: ProjectRow;
  source: SourceRow;
  thread: ThreadRow;
}

/**
 * Turn a reference the user typed into the rows it names.
 *
 * Ambiguity is an error carrying the candidates rather than a first match:
 * picking one would silently open the wrong thread, and the user has no way to
 * tell from the output that it happened.
 */
export function resolveThreadRef(
  store: Store,
  input: string,
  options: ResolveThreadRefOptions = {},
): ResolvedThreadRef {
  const parts = parseThreadRef(input);
  const { project, sourceKey } = resolveProject(store, parts, options.projectSlug, input);
  const sources = candidateSources(store, project, sourceKey);

  const matches: ResolvedThreadRef[] = [];
  for (const source of sources) {
    // Each source's own kinds, not a global list. Kinds are an open vocabulary,
    // so probing a fixed set would fail to resolve anything a future source type
    // names differently — and this is both narrower and cheaper besides.
    const kinds = options.kind ? [options.kind] : source.kinds;
    for (const kind of kinds) {
      const thread = store.threads.findThread(source.id, kind, parts.number);
      if (thread) {
        matches.push({ ref: threadRefOf(project, source, thread), project, source, thread });
      }
    }
  }

  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    const where = sourceKey === null ? `project "${project.slug}"` : `${project.slug}/${sourceKey}`;
    throw new NotFoundError(
      `No thread #${parts.number} in ${where}.`,
      'Run `chyme sync`, or check the reference with `chyme activity`.',
    );
  }

  const candidates = matches
    .map((match) => `${match.ref} (${match.thread.kind})`)
    .join(', ');
  throw new ChymeError(
    `"${input}" matches ${matches.length} threads.`,
    `Name one of: ${candidates}`,
  );
}

function resolveProject(
  store: Store,
  parts: ThreadRefParts,
  fallbackSlug: string | undefined,
  input: string,
): { project: ProjectRow; sourceKey: string | null } {
  if (parts.projectSlug === null) {
    if (fallbackSlug === undefined) {
      throw new ChymeError(`"${input}" does not say which project it is in.`, HINT);
    }
    return { project: store.projects.requireProject(fallbackSlug), sourceKey: null };
  }

  const project = store.projects.findProject(parts.projectSlug);
  if (project) return { project, sourceKey: parts.sourceKey };

  // `acme/api#412` has the same shape as `<project>/<source>#412`, so a leading
  // segment that names no project is retried as the head of a source key in the
  // project the caller is already working in.
  if (fallbackSlug !== undefined) {
    const sourceKey =
      parts.sourceKey === null ? parts.projectSlug : `${parts.projectSlug}/${parts.sourceKey}`;
    return { project: store.projects.requireProject(fallbackSlug), sourceKey };
  }

  const known = store.projects.listProjects().map((row) => row.slug);
  throw new NotFoundError(
    `No project "${parts.projectSlug}" in the store.`,
    known.length > 0 ? `Known projects: ${known.join(', ')}` : 'Run `chyme sync` first.',
  );
}

function candidateSources(
  store: Store,
  project: ProjectRow,
  sourceKey: string | null,
): SourceRow[] {
  const sources = store.sources.listSources(project.id);
  if (sourceKey === null) return sources;

  // Sources are inconsistent about case in repository names; the store keeps
  // what the driver reported, and matching insensitively saves the user from
  // having to remember which.
  const wanted = sourceKey.toLowerCase();
  const matches = sources.filter((source) => source.key.toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new NotFoundError(
      `Project "${project.slug}" has no source "${sourceKey}".`,
      sources.length > 0
        ? `Its sources: ${sources.map((source) => source.key).join(', ')}`
        : 'Add one to your config and run `chyme sync`.',
    );
  }
  return matches;
}
