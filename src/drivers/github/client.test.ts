import { describe, expect, it } from 'vitest';
import { DriverError } from '../../util/errors.js';
import { GitHubClient, backoffDelayMs } from './client.js';

/**
 * No network. A fake `fetch` is handed to Octokit, and `sleep` is replaced with
 * a recorder, so the retry ladder can be asserted without waiting for it.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Harness {
  client: GitHubClient;
  /** Milliseconds the client asked to wait, in order. */
  waits: number[];
  calls: number;
}

const NOW = Date.parse('2026-07-29T12:00:00Z');

function harness(replies: Reply[], maxAttempts = 4): Harness {
  const state: Harness = {
    waits: [],
    calls: 0,
    client: undefined as unknown as GitHubClient,
  };

  const fetchStub: typeof globalThis.fetch = async () => {
    const reply = replies[Math.min(state.calls, replies.length - 1)]!;
    state.calls += 1;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };

  state.client = new GitHubClient({
    token: 'test-token',
    maxAttempts,
    fetch: fetchStub,
    sleep: async (ms) => {
      state.waits.push(ms);
    },
    now: () => NOW,
  });

  return state;
}

async function failure(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
    expect.unreachable('expected the request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(DriverError);
    return error as DriverError;
  }
}

describe('GitHubClient', () => {
  it('returns the GraphQL data envelope unwrapped', async () => {
    const { client } = harness([{ status: 200, body: { data: { viewer: { login: 'rmoss' } } } }]);
    await expect(client.graphql('query {}', {})).resolves.toEqual({ viewer: { login: 'rmoss' } });
  });

  it('returns REST data with its headers', async () => {
    const { client } = harness([
      { status: 200, body: [{ filename: 'a.ts' }], headers: { 'x-ratelimit-remaining': '4999' } },
    ]);
    const result = await client.rest<{ filename: string }[]>('GET /x', {});
    expect(result.data).toEqual([{ filename: 'a.ts' }]);
    expect(result.headers['x-ratelimit-remaining']).toBe('4999');
  });

  describe('authentication', () => {
    it('translates 401 into advice about the token', async () => {
      const { client, calls } = harness([{ status: 401, body: { message: 'Bad credentials' } }]);
      const error = await failure(client.rest('GET /x', {}));
      expect(error.message).toContain('401');
      expect(error.hint).toContain('${GITHUB_TOKEN}');
      expect(calls).toBeLessThanOrEqual(1);
    });

    it('does not retry a rejected token', async () => {
      const state = harness([{ status: 401, body: {} }]);
      await failure(state.client.rest('GET /x', {}));
      expect(state.calls).toBe(1);
      expect(state.waits).toEqual([]);
    });
  });

  describe('rate limits', () => {
    it('stops on an exhausted primary limit and says when it resets', async () => {
      const state = harness([
        {
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 43 * 60),
          },
        },
      ]);
      const error = await failure(state.client.rest('GET /x', {}));
      expect(error.message).toContain('5000/hour');
      expect(error.hint).toContain('43m');
      expect(error.hint).toContain('2026-07-29T12:43:00');
      // An hour is too long to sit in a sleep; the run stops and says so.
      expect(state.calls).toBe(1);
    });

    it('honours Retry-After on a secondary limit, then succeeds', async () => {
      const state = harness([
        { status: 403, body: { message: 'secondary rate limit' }, headers: { 'retry-after': '3' } },
        { status: 200, body: { data: { ok: true } } },
      ]);
      await expect(state.client.graphql('query {}', {})).resolves.toEqual({ ok: true });
      expect(state.waits).toEqual([3000]);
    });

    it('refuses a Retry-After longer than a run should wait', async () => {
      const state = harness([
        { status: 429, body: {}, headers: { 'retry-after': '900' } },
      ]);
      const error = await failure(state.client.rest('GET /x', {}));
      expect(error.hint).toContain('900s');
      expect(state.waits).toEqual([]);
    });

    it('reads a GraphQL RATE_LIMITED error, which arrives as a 200', async () => {
      const state = harness([
        {
          status: 200,
          body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
          headers: { 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 600) },
        },
      ]);
      const error = await failure(state.client.graphql('query {}', {}));
      expect(error.message).toContain('rate limit');
      expect(error.hint).toContain('10m');
      expect(state.calls).toBe(1);
    });
  });

  describe('retries', () => {
    it('backs off exponentially through a transient 5xx', async () => {
      const state = harness([
        { status: 502, body: { message: 'Bad gateway' } },
        { status: 502, body: { message: 'Bad gateway' } },
        { status: 200, body: { data: { ok: true } } },
      ]);
      await expect(state.client.graphql('query {}', {})).resolves.toEqual({ ok: true });
      expect(state.waits).toEqual([backoffDelayMs(1), backoffDelayMs(2)]);
    });

    it('gives up after the configured number of attempts', async () => {
      const state = harness([{ status: 503, body: { message: 'unavailable' } }], 3);
      const error = await failure(state.client.rest('GET /x', {}));
      expect(state.calls).toBe(3);
      expect(state.waits).toHaveLength(2);
      expect(error.hint).toContain('githubstatus.com');
    });

    it('retries GitHub’s prose-shaped transient GraphQL failure', async () => {
      const state = harness([
        {
          status: 200,
          body: { data: null, errors: [{ message: 'Something went wrong while executing your query.' }] },
        },
        { status: 200, body: { data: { ok: true } } },
      ]);
      await expect(state.client.graphql('query {}', {})).resolves.toEqual({ ok: true });
      expect(state.calls).toBe(2);
    });

    it('does not retry a query that is simply wrong', async () => {
      const state = harness([
        {
          status: 200,
          body: { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] },
        },
      ]);
      const error = await failure(state.client.graphql('query {}', {}));
      expect(error.message).toContain('Could not resolve');
      expect(state.calls).toBe(1);
    });

    it('does not retry a 404', async () => {
      const state = harness([{ status: 404, body: { message: 'Not Found' } }]);
      const error = await failure(state.client.rest('GET /x', {}));
      expect(state.calls).toBe(1);
      expect(error.hint).toContain('repo');
    });
  });

  it('lets an abort through as the caller’s own decision', async () => {
    const controller = new AbortController();
    const { client } = harness([{ status: 500, body: {} }]);
    controller.abort(new Error('caller changed its mind'));
    await expect(client.rest('GET /x', {}, controller.signal)).rejects.toThrow(
      'caller changed its mind',
    );
  });
});

describe('backoffDelayMs', () => {
  it('doubles, and stays inside a few seconds over a bounded run', () => {
    expect([1, 2, 3].map(backoffDelayMs)).toEqual([500, 1000, 2000]);
  });
});
