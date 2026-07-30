import type { Store } from '../store/index.js';
import { ChymeError, NotFoundError } from '../util/errors.js';
import { toIso, type TimeSpec } from '../util/time.js';

/**
 * Turning `--since` / `--until` into two instants.
 *
 * Windows are half-open `[since, until)`, matching the store, so two adjacent
 * digests neither overlap nor lose the instant between them.
 */

export type WindowOrigin = 'explicit' | 'digest' | 'now';

export interface ActivityWindow {
  /** Inclusive. */
  since: string;
  /** Exclusive. */
  until: string;
  sinceOrigin: WindowOrigin;
  untilOrigin: WindowOrigin;
  /** The digest `last` resolved against, when one did. */
  digestId: number | null;
}

export interface ResolvedInstant {
  at: string;
  origin: WindowOrigin;
  digestId: number | null;
}

/**
 * Resolve one end of a window.
 *
 * `last` means the end of the most recent saved digest window — "what haven't I
 * seen". With no saved digest there is no honest answer, so this throws rather
 * than falling back to a default span: the user asked a question about their own
 * reading history, and a plausible-looking wrong answer to it is invisible.
 */
export function resolveInstant(store: Store, projectId: number, spec: TimeSpec): ResolvedInstant {
  if (spec.kind === 'instant') {
    return { at: spec.at, origin: 'explicit', digestId: null };
  }

  const digest = store.digests.latestDigest(projectId);
  if (!digest) {
    throw new NotFoundError(
      'This project has no saved digest, so "last" has nothing to measure from.',
      'Pass an explicit window, e.g. --since 7d or --since 2026-07-01.',
    );
  }
  return { at: digest.windowEnd, origin: 'digest', digestId: digest.id };
}

export interface WindowOptions {
  since: TimeSpec;
  /** Defaults to now, which is what "since Tuesday" means in conversation. */
  until?: TimeSpec | null;
  /** Injected for tests; defaults to the wall clock. */
  now?: Date;
}

export function resolveWindow(
  store: Store,
  projectId: number,
  options: WindowOptions,
): ActivityWindow {
  const since = resolveInstant(store, projectId, options.since);
  const until = options.until
    ? resolveInstant(store, projectId, options.until)
    : { at: toIso(options.now ?? new Date()), origin: 'now' as WindowOrigin, digestId: null };

  if (since.at >= until.at) {
    throw new ChymeError(
      `The window ${since.at} → ${until.at} contains no time.`,
      since.origin === 'digest'
        ? 'The last saved digest already covers up to now. Pass an explicit --since to re-read it.'
        : 'Check --since and --until: the start must be before the end.',
    );
  }

  return {
    since: since.at,
    until: until.at,
    sinceOrigin: since.origin,
    untilOrigin: until.origin,
    digestId: since.digestId ?? until.digestId,
  };
}
