import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../../domain/types.js';
import { NotImplementedError } from '../../util/errors.js';
import type { GitHubClient } from './client.js';
import { GitHubDriver } from './driver.js';
import * as Q from './queries.js';

/**
 * The client is stubbed with canned GraphQL responses. What is under test is
 * the part of the driver that has no equivalent anywhere else: the inversion of
 * GitHub's newest-first ordering into the oldest-first stream sync consumes.
 */

const SOURCE: SourceRef = { driver: 'github', key: 'acme/widget' };

interface Recorded {
  document: string;
  variables: Record<string, unknown>;
}

function actor(login: string): Record<string, unknown> {
  return { __typename: 'User', login, id: `U_${login}` };
}

function pr(number: number, updatedAt: string): Record<string, unknown> {
  return {
    id: `PR_${number}`,
    number,
    title: `pr ${number}`,
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/acme/widget/pull/${number}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    closedAt: null,
    mergedAt: null,
    author: actor('rmoss'),
    mergedBy: null,
    labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  };
}

function issue(number: number, updatedAt: string): Record<string, unknown> {
  return {
    id: `I_${number}`,
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    stateReason: null,
    url: `https://github.com/acme/widget/issues/${number}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    closedAt: null,
    author: null,
    labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  };
}

function connection(nodes: unknown[], endCursor: string | null = null): Record<string, unknown> {
  return {
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes,
  };
}

function stubClient(responses: (recorded: Recorded) => unknown): {
  client: GitHubClient;
  log: Recorded[];
} {
  const log: Recorded[] = [];
  const client = {
    async graphql(document: string, variables: Record<string, unknown>): Promise<unknown> {
      const recorded = { document, variables };
      log.push(recorded);
      return responses(recorded);
    },
    async rest(): Promise<unknown> {
      throw new Error('the listing path must not touch REST');
    },
  };
  return { client: client as unknown as GitHubClient, log };
}

async function collect(driver: GitHubDriver, since: string | null): Promise<string[]> {
  const result: string[] = [];
  for await (const summary of driver.listThreadsUpdatedSince(SOURCE, {
    since,
    kinds: ['pull_request', 'issue'],
  })) {
    result.push(`${summary.kind}#${summary.number}@${summary.updatedAt}`);
  }
  return result;
}

describe('listThreadsUpdatedSince', () => {
  it('yields ascending by updatedAt, interleaving pull requests and issues', async () => {
    const { client } = stubClient(({ document }) => {
      if (document === Q.LIST_PULL_REQUESTS) {
        return {
          repository: {
            pullRequests: connection([
              pr(9, '2026-07-22T10:00:00Z'),
              pr(7, '2026-07-20T10:00:00Z'),
            ]),
          },
        };
      }
      return {
        repository: {
          issues: connection([
            issue(50, '2026-07-21T10:00:00Z'),
            issue(48, '2026-07-19T10:00:00Z'),
          ]),
        },
      };
    });

    // GitHub handed these back newest-first, in two separate walks. Sync needs
    // one oldest-first stream, or its cursor would jump backwards.
    expect(await collect(new GitHubDriver(client), null)).toEqual([
      'issue#48@2026-07-19T10:00:00Z',
      'pull_request#7@2026-07-20T10:00:00Z',
      'issue#50@2026-07-21T10:00:00Z',
      'pull_request#9@2026-07-22T10:00:00Z',
    ]);
  });

  it('stops paging as soon as it crosses below the watermark', async () => {
    const { client, log } = stubClient(({ document }) => {
      if (document === Q.LIST_PULL_REQUESTS) {
        return {
          repository: {
            pullRequests: connection(
              [
                pr(9, '2026-07-22T10:00:00Z'),
                // Below the watermark: everything after this is older still.
                pr(3, '2026-06-01T10:00:00Z'),
              ],
              'cursor-there-is-more',
            ),
          },
        };
      }
      return { repository: { issues: connection([]) } };
    });

    const result = await collect(new GitHubDriver(client), '2026-07-01T00:00:00Z');
    expect(result).toEqual(['pull_request#9@2026-07-22T10:00:00Z']);
    // One page each, despite hasNextPage being true on the pull requests.
    expect(log.filter((entry) => entry.document === Q.LIST_PULL_REQUESTS)).toHaveLength(1);
  });

  it('includes an old thread that was touched recently', async () => {
    const { client } = stubClient(({ document }) =>
      document === Q.LIST_PULL_REQUESTS
        ? { repository: { pullRequests: connection([pr(2, '2026-07-28T10:00:00Z')]) } }
        : { repository: { issues: connection([]) } },
    );

    // Opened in January, argued over yesterday. Filtering on creation time
    // would miss exactly the thread worth reading.
    const result = await collect(new GitHubDriver(client), '2026-07-01T00:00:00Z');
    expect(result).toEqual(['pull_request#2@2026-07-28T10:00:00Z']);
  });

  it('treats the watermark as inclusive', async () => {
    const { client } = stubClient(({ document }) =>
      document === Q.LIST_PULL_REQUESTS
        ? { repository: { pullRequests: connection([pr(1, '2026-07-01T00:00:00Z')]) } }
        : { repository: { issues: connection([]) } },
    );
    expect(await collect(new GitHubDriver(client), '2026-07-01T00:00:00Z')).toHaveLength(1);
  });

  it('follows the cursor across pages while still above the watermark', async () => {
    let page = 0;
    const { client } = stubClient(({ document }) => {
      if (document !== Q.LIST_PULL_REQUESTS) return { repository: { issues: connection([]) } };
      page += 1;
      return page === 1
        ? { repository: { pullRequests: connection([pr(9, '2026-07-22T10:00:00Z')], 'c1') } }
        : { repository: { pullRequests: connection([pr(8, '2026-07-21T10:00:00Z')]) } };
    });

    expect(await collect(new GitHubDriver(client), null)).toEqual([
      'pull_request#8@2026-07-21T10:00:00Z',
      'pull_request#9@2026-07-22T10:00:00Z',
    ]);
    expect(page).toBe(2);
  });

  it('only asks for the kinds the source configured', async () => {
    const { client, log } = stubClient(() => ({
      repository: { pullRequests: connection([]), issues: connection([]) },
    }));
    const driver = new GitHubDriver(client);
    for await (const _ of driver.listThreadsUpdatedSince(SOURCE, {
      since: null,
      kinds: ['issue'],
    })) {
      // no-op
    }
    expect(log.map((entry) => entry.document)).toEqual([Q.LIST_ISSUES]);
  });

  it('refuses discussions rather than pretending a repository has none', async () => {
    const { client } = stubClient(() => ({ repository: { pullRequests: connection([]) } }));
    const driver = new GitHubDriver(client);
    const iterator = driver.listThreadsUpdatedSince(SOURCE, {
      since: null,
      kinds: ['discussion'],
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(NotImplementedError);
  });
});

describe('fetchThreadDetail', () => {
  it('never fetches files for an issue', async () => {
    const { client, log } = stubClient(({ document }) => {
      if (document !== Q.ISSUE_DETAIL) throw new Error(`unexpected document: ${document}`);
      return {
        repository: {
          issue: { ...issue(88, '2026-07-22T10:00:00Z'), body: 'text', comments: connection([]) },
        },
      };
    });

    const detail = await new GitHubDriver(client).fetchThreadDetail(
      SOURCE,
      { kind: 'issue', number: 88 },
      { includePatches: true, maxPatchBytes: 65_536 },
    );

    expect(detail.files).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it('refuses a discussion rather than returning an empty thread', async () => {
    const { client } = stubClient(() => ({}));
    await expect(
      new GitHubDriver(client).fetchThreadDetail(
        SOURCE,
        { kind: 'discussion', number: 1 },
        { includePatches: false, maxPatchBytes: 1024 },
      ),
    ).rejects.toThrow(NotImplementedError);
  });

  it('skips the REST detour entirely on a discourse-only sync', async () => {
    const { client } = stubClient(({ document }) => {
      if (document !== Q.PULL_REQUEST_DETAIL) throw new Error(`unexpected document: ${document}`);
      return {
        repository: {
          pullRequest: {
            ...pr(412, '2026-07-22T10:00:00Z'),
            body: 'text',
            comments: connection([]),
            reviews: connection([]),
            commits: connection([]),
            files: connection([
              { path: 'src/upload.ts', additions: 2, deletions: 1, changeType: 'MODIFIED' },
            ]),
          },
        },
      };
    });

    // The stub throws if REST is touched at all.
    const detail = await new GitHubDriver(client).fetchThreadDetail(
      SOURCE,
      { kind: 'pull_request', number: 412 },
      { includePatches: false, maxPatchBytes: 65_536 },
    );

    expect(detail.files).toEqual([
      {
        path: 'src/upload.ts',
        previousPath: null,
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: null,
        patchTruncated: false,
      },
    ]);
  });
});
