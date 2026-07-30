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

/** One way of reading the text before the `#`. */
interface Interpretation {
  project: ProjectRow;
  /** Null when the reference named no source: every source in the project is a candidate. */
  sourceKey: string | null;
}

/**
 * Turn a reference the user typed into the rows it names.
 *
 * Every reading of the text is resolved, not just the first one that looks
 * plausible: `acme/api#412` is both `<project>/<source>` and a bare source key,
 * and which of those is real depends on what the user happened to name their
 * project. Ambiguity is an error carrying the candidates rather than a first
 * match — picking one would silently open the wrong thread, and the user has no
 * way to tell from the output that it happened.
 */
export function resolveThreadRef(
  store: Store,
  input: string,
  options: ResolveThreadRefOptions = {},
): ResolvedThreadRef {
  const parts = parseThreadRef(input);
  const readings = interpret(store, parts, options.projectSlug, input);

  const matches: ResolvedThreadRef[] = [];
  const seen = new Set<number>();
  // Kept so a miss can say how far it got: naming a source the project does not
  // have is a different mistake from naming a thread the source does not have.
  let noThread: Interpretation | null = null;
  let noSource: Interpretation | null = null;

  for (const reading of readings) {
    const sources = matchingSources(store, reading.project, reading.sourceKey);
    if (sources.length === 0 && reading.sourceKey !== null) {
      noSource ??= reading;
      continue;
    }
    noThread ??= reading;

    for (const source of sources) {
      for (const kind of probeKinds(store, source, parts.number, options.kind)) {
        const thread = store.threads.findThread(source.id, kind, parts.number);
        // One row reached by two readings is not an ambiguity: `acme#5` under
        // `--project acme` searches every source in the project and then the
        // source keyed `acme`, which may well be the same one.
        if (thread && !seen.has(thread.id)) {
          seen.add(thread.id);
          matches.push({
            ref: threadRefOf(reading.project, source, thread),
            project: reading.project,
            source,
            thread,
          });
        }
      }
    }
  }

  if (matches.length === 1) return matches[0]!;

  if (matches.length > 1) {
    const candidates = matches
      .map((match) => `${match.ref} (${match.thread.kind})`)
      .join(', ');
    throw new ChymeError(
      `"${input}" matches ${matches.length} threads.`,
      `Name one of: ${candidates}`,
    );
  }

  if (noThread) {
    const where =
      noThread.sourceKey === null
        ? `project "${noThread.project.slug}"`
        : `${noThread.project.slug}/${noThread.sourceKey}`;
    throw new NotFoundError(
      `No thread #${parts.number} in ${where}.`,
      'Run `chyme sync`, or check the reference with `chyme activity`.',
    );
  }

  const reading = noSource!;
  const sources = store.sources.listSources(reading.project.id);
  throw new NotFoundError(
    `Project "${reading.project.slug}" has no source "${reading.sourceKey}".`,
    sources.length > 0
      ? `Its sources: ${sources.map((source) => source.key).join(', ')}`
      : 'Add one to your config and run `chyme sync`.',
  );
}

/**
 * Every way the prefix could be read, in the order a message about them should
 * be phrased.
 *
 * `acme/api#412` is `<project>/<source>` when a project is called `acme` and
 * `<source>` when one is not — and when a project *is* called `acme` and the
 * user is working in another one that follows `acme/api`, it is both. Committing
 * to the project reading on the first hit made the second case unresolvable for
 * a thread that plainly exists.
 */
function interpret(
  store: Store,
  parts: ThreadRefParts,
  fallbackSlug: string | undefined,
  input: string,
): Interpretation[] {
  if (parts.projectSlug === null) {
    if (fallbackSlug === undefined) {
      throw new ChymeError(`"${input}" does not say which project it is in.`, HINT);
    }
    return [{ project: store.projects.requireProject(fallbackSlug), sourceKey: null }];
  }

  const readings: Interpretation[] = [];

  const named = store.projects.findProject(parts.projectSlug);
  if (named) readings.push({ project: named, sourceKey: parts.sourceKey });

  if (fallbackSlug !== undefined) {
    // The whole prefix as a source key, in the project the caller is working in.
    const sourceKey =
      parts.sourceKey === null ? parts.projectSlug : `${parts.projectSlug}/${parts.sourceKey}`;
    // With no other reading left, an unknown fallback project is the failure
    // worth reporting; with one, it is simply a reading that does not apply.
    const fallback = named
      ? store.projects.findProject(fallbackSlug)
      : store.projects.requireProject(fallbackSlug);
    if (fallback) readings.push({ project: fallback, sourceKey });
  }

  if (readings.length === 0) {
    const known = store.projects.listProjects().map((row) => row.slug);
    throw new NotFoundError(
      `No project "${parts.projectSlug}" in the store.`,
      known.length > 0 ? `Known projects: ${known.join(', ')}` : 'Run `chyme sync` first.',
    );
  }
  return readings;
}

function matchingSources(
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
  return sources.filter((source) => source.key.toLowerCase() === wanted);
}

/**
 * The kinds worth probing for this number in this source.
 *
 * Read from the store, not from `source.kinds`. That column is the config's
 * current intent, and narrowing it — `["pull_request","issue"]` down to
 * `["pull_request"]` — deliberately leaves the already-synced issues in place,
 * where `activity` still enumerates them and still prints their references. A
 * reference this tool just handed the user must not then be unresolvable.
 *
 * Still not a fixed list, either: thread kinds are an open vocabulary (see
 * `src/domain/types.ts`), so a new source type must not require editing one.
 */
function probeKinds(
  store: Store,
  source: SourceRow,
  number: number,
  only: ThreadKind | undefined,
): ThreadKind[] {
  if (only) return [only];
  return store.db
    .prepare('SELECT DISTINCT kind FROM thread WHERE source_id = ? AND number = ?')
    .all(source.id, number)
    .map((row) => String(row['kind']) as ThreadKind);
}
