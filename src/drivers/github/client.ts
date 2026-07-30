import { graphql as octokitGraphql } from '@octokit/graphql';
import { request as octokitRequest } from '@octokit/request';
import { DriverError } from '../../util/errors.js';

/**
 * Auth, transport, retry, and the translation of GitHub's several dialects of
 * failure into one DriverError with something useful to say.
 *
 * Nothing above this file should ever see an HTTP status, a GraphQL error type,
 * or a rate-limit header.
 */

const DRIVER_ID = 'github';

/** Four attempts: enough for a blip, not a stall. */
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

/**
 * Total time one request may spend asleep across all its retries.
 *
 * `MAX_HONOURED_RETRY_AFTER_MS` bounds a single sleep, which is not the same
 * thing: three honoured pauses at the maximum would be three minutes of silence
 * for one request, and a thread costs five or more requests. Nothing is printed
 * while it waits, so past a point this is indistinguishable from a hang — which
 * is exactly what the comment above the attempt count used to claim was
 * impossible.
 */
const MAX_TOTAL_BACKOFF_MS = 90_000;

/**
 * A secondary rate limit longer than this is not a blip, it is a signal to stop
 * and let a human decide. Sitting in a sleep for minutes looks like a hang.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

/** GitHub's own guidance for a secondary limit that arrives without a Retry-After. */
const SECONDARY_LIMIT_BACKOFF_MS = 60_000;

/** The wording GitHub uses for secondary limits, in both its current and older forms. */
const SECONDARY_LIMIT = /secondary rate limit|abuse detection/i;

/**
 * GraphQL error types that mean "try again", as opposed to "you asked for
 * something that does not exist". GitHub also reports transient backend
 * failures as a 200 with a prose message, hence the string check.
 */
const TRANSIENT_GRAPHQL_TYPES = new Set(['SERVICE_UNAVAILABLE', 'INTERNAL_SERVER_ERROR']);
const TRANSIENT_GRAPHQL_TEXT = 'something went wrong while executing your query';

export interface GitHubClientOptions {
  token: string;
  /** Bounded so a broken upstream fails the run rather than pinning it forever. */
  maxAttempts?: number;
  /** Injected in tests so backoff costs no wall-clock time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface RestResult<T> {
  data: T;
  headers: Record<string, string | number | undefined>;
}

interface GraphQlErrorEntry {
  type?: string;
  message?: string;
}

/**
 * What to do about a failure, decided in one place and acted on in another.
 * `'backoff'` defers the delay to the retry loop, which is the only thing that
 * knows which attempt this is.
 */
type Retry = 'never' | 'backoff' | { afterMs: number };

interface Verdict {
  error: DriverError;
  retry: Retry;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Octokit's error classes come from packages we do not depend on directly, so
 * they are recognised by shape rather than by `instanceof`. A transitive import
 * would break the day a lockfile hoists a second copy.
 */
function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function readHeaders(error: unknown): Record<string, string | number | undefined> {
  if (typeof error !== 'object' || error === null) return {};
  const direct = (error as { headers?: unknown }).headers;
  if (direct && typeof direct === 'object') {
    return direct as Record<string, string | number | undefined>;
  }
  const response = (error as { response?: { headers?: unknown } }).response;
  if (response?.headers && typeof response.headers === 'object') {
    return response.headers as Record<string, string | number | undefined>;
  }
  return {};
}

function readGraphQlErrors(error: unknown): GraphQlErrorEntry[] {
  if (typeof error !== 'object' || error === null) return [];
  const errors = (error as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (errors as GraphQlErrorEntry[]) : [];
}

function headerNumber(
  headers: Record<string, string | number | undefined>,
  name: string,
): number | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * `Retry-After` in milliseconds.
 *
 * RFC 9110 permits either a number of seconds or an HTTP-date, and GitHub sends
 * both. Reading only the numeric form meant the date form fell through as "no
 * Retry-After at all", which then got diagnosed as a token-scope problem.
 * Negative and empty values are refused rather than becoming an instant retry.
 */
function retryAfterMs(
  headers: Record<string, string | number | undefined>,
  nowMs: number,
): number | null {
  const raw = headers['retry-after'];
  if (raw === undefined) return null;

  const text = String(raw).trim();
  if (text === '') return null;

  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;

  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** "in 43m (at 2026-07-29T14:05:00Z)" — both forms, because both get used. */
function describeReset(resetEpochSeconds: number | null, nowMs: number): string {
  if (resetEpochSeconds === null) return 'shortly';
  const resetMs = resetEpochSeconds * 1000;
  const minutes = Math.max(0, Math.ceil((resetMs - nowMs) / 60_000));
  return `in ${minutes}m (at ${new Date(resetMs).toISOString()})`;
}

const TOKEN_HINT =
  'Set credentials.github.token in the Chyme config. It supports ${GITHUB_TOKEN} interpolation, so the token need never be written to disk.';

export class GitHubClient {
  readonly #graphql: typeof octokitGraphql;
  readonly #request: typeof octokitRequest;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;

  constructor(options: GitHubClientOptions) {
    const requestDefaults = {
      headers: { authorization: `Bearer ${options.token}` },
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    };

    this.#graphql = octokitGraphql.defaults(requestDefaults);
    this.#request = octokitRequest.defaults(requestDefaults);
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  async graphql<T>(
    document: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#attempt(
      () =>
        this.#graphql<T>(document, {
          ...variables,
          ...(signal ? { request: { signal } } : {}),
        }),
      signal,
    );
  }

  async rest<T>(
    route: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RestResult<T>> {
    return this.#attempt(async () => {
      const response = await this.#request(route, {
        ...params,
        ...(signal ? { request: { signal } } : {}),
      });
      return {
        data: response.data as T,
        headers: response.headers as Record<string, string | number | undefined>,
      };
    }, signal);
  }

  async #attempt<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: DriverError | null = null;
    let sleptMs = 0;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        // An abort is the caller's own decision, not a source failure.
        if (signal?.aborted) throw error;

        const verdict = this.#classify(error);
        lastError = verdict.error;

        if (verdict.retry === 'never' || attempt === this.#maxAttempts) {
          throw verdict.error;
        }
        const delayMs =
          verdict.retry === 'backoff' ? backoffDelayMs(attempt) : verdict.retry.afterMs;

        // A deadline across the whole request, not just this one sleep.
        if (sleptMs + delayMs > MAX_TOTAL_BACKOFF_MS) {
          throw new DriverError(
            verdict.error.message,
            DRIVER_ID,
            `Retrying would mean waiting more than ${Math.round(MAX_TOTAL_BACKOFF_MS / 1000)}s on this one request. Re-run the sync later; it resumes from its watermark.`,
            error,
          );
        }

        await this.#sleep(delayMs, signal);
        sleptMs += delayMs;
      }
    }

    // Unreachable while maxAttempts >= 1; kept so the type is honest.
    throw lastError ?? new DriverError('GitHub request failed.', DRIVER_ID);
  }

  #classify(error: unknown): Verdict {
    const status = readStatus(error);
    const headers = readHeaders(error);
    const graphQlErrors = readGraphQlErrors(error);
    const message = error instanceof Error ? error.message : String(error);

    if (status === 401) {
      return {
        retry: 'never',
        error: new DriverError(
          'GitHub rejected the credentials (HTTP 401).',
          DRIVER_ID,
          `The token is missing, expired, or revoked. ${TOKEN_HINT}`,
          error,
        ),
      };
    }

    if (status === 403 || status === 429) {
      return this.#classifyThrottle(error, status, headers, message);
    }

    if (status === 404) {
      return {
        retry: 'never',
        error: new DriverError(
          'GitHub returned 404 for this resource.',
          DRIVER_ID,
          'Either the repository name is wrong or the token cannot see it. A private repository needs a token with `repo` scope, and an organisation with SAML enforcement needs that token authorised for the org.',
          error,
        ),
      };
    }

    if (graphQlErrors.length > 0) {
      return this.#classifyGraphQl(error, graphQlErrors, headers);
    }

    // 5xx and outright transport failures (DNS, reset connections) are the
    // things worth retrying; anything else is our own bad request.
    if (status === null || status >= 500) {
      return {
        retry: 'backoff',
        error: new DriverError(
          `GitHub request failed: ${message}`,
          DRIVER_ID,
          'This looks transient. If it persists, check https://www.githubstatus.com.',
          error,
        ),
      };
    }

    return {
      retry: 'never',
      error: new DriverError(
        `GitHub request failed (HTTP ${status}): ${message}`,
        DRIVER_ID,
        undefined,
        error,
      ),
    };
  }

  #classifyThrottle(
    error: unknown,
    status: number,
    headers: Record<string, string | number | undefined>,
    message: string,
  ): Verdict {
    const waitMs = retryAfterMs(headers, this.#now());
    if (waitMs !== null) {
      const seconds = Math.ceil(waitMs / 1000);
      if (waitMs <= MAX_HONOURED_RETRY_AFTER_MS) {
        return {
          retry: { afterMs: waitMs },
          error: new DriverError(
            `GitHub applied a secondary rate limit (HTTP ${status}).`,
            DRIVER_ID,
            `GitHub asked for a ${seconds}s pause.`,
            error,
          ),
        };
      }
      return {
        retry: 'never',
        error: new DriverError(
          `GitHub applied a secondary rate limit (HTTP ${status}).`,
          DRIVER_ID,
          `GitHub asked for a ${seconds}s pause, which is too long to wait inside one run. Re-run the sync after that; it resumes from where it stopped.`,
          error,
        ),
      };
    }

    // Remaining === 0 is the primary hourly budget, and its reset can be the
    // better part of an hour away. Waiting that out silently is worse than
    // stopping and saying when to come back.
    if (headerNumber(headers, 'x-ratelimit-remaining') === 0) {
      const reset = headerNumber(headers, 'x-ratelimit-reset');
      const limit = headerNumber(headers, 'x-ratelimit-limit');
      return {
        retry: 'never',
        error: new DriverError(
          `GitHub rate limit exhausted${limit === null ? '' : ` (${limit}/hour)`}.`,
          DRIVER_ID,
          `The limit resets ${describeReset(reset, this.#now())}. Sync resumes from its watermark, so re-running after that loses nothing.`,
          error,
        ),
      };
    }

    // A secondary limit does not touch the primary hourly budget, and GitHub
    // does not always send a usable Retry-After with one. Without this the
    // response fell through to the token-scope branch below and told the user to
    // fix their credentials when the correct advice was to wait.
    if (SECONDARY_LIMIT.test(message)) {
      return {
        retry: { afterMs: SECONDARY_LIMIT_BACKOFF_MS },
        error: new DriverError(
          `GitHub applied a secondary rate limit (HTTP ${status}).`,
          DRIVER_ID,
          'No pause length was given, so Chyme waits a minute and tries again.',
          error,
        ),
      };
    }

    return {
      retry: 'never',
      error: new DriverError(
        `GitHub refused the request (HTTP ${status}): ${message}`,
        DRIVER_ID,
        `The token may lack the scope this repository needs. ${TOKEN_HINT}`,
        error,
      ),
    };
  }

  #classifyGraphQl(
    error: unknown,
    errors: GraphQlErrorEntry[],
    headers: Record<string, string | number | undefined>,
  ): Verdict {
    const summary = errors
      .map((entry) => entry.message ?? entry.type ?? 'unknown error')
      .join('; ');
    const types = new Set(errors.map((entry) => entry.type).filter(Boolean));

    if (types.has('RATE_LIMITED')) {
      const reset = headerNumber(headers, 'x-ratelimit-reset');
      return {
        retry: 'never',
        error: new DriverError(
          'GitHub GraphQL rate limit exhausted.',
          DRIVER_ID,
          `The limit resets ${describeReset(reset, this.#now())}. Sync resumes from its watermark, so re-running after that loses nothing.`,
          error,
        ),
      };
    }

    if (types.has('NOT_FOUND')) {
      return {
        retry: 'never',
        error: new DriverError(
          `GitHub could not find part of the requested data: ${summary}`,
          DRIVER_ID,
          'Check the source key, and that the token can see this repository.',
          error,
        ),
      };
    }

    const transient =
      [...types].some((type) => type !== undefined && TRANSIENT_GRAPHQL_TYPES.has(type)) ||
      summary.toLowerCase().includes(TRANSIENT_GRAPHQL_TEXT);

    return {
      retry: transient ? 'backoff' : 'never',
      error: new DriverError(
        `GitHub GraphQL error: ${summary}`,
        DRIVER_ID,
        transient ? 'This looks transient; the request will be retried.' : undefined,
        error,
      ),
    };
  }
}

/**
 * Exponential backoff for attempt N (1-based): 500ms, 1s, 2s.
 *
 * Exported so the ladder can be asserted without waiting for it, and so its
 * total cost is a number someone can read rather than infer from a loop.
 */
export function backoffDelayMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}
