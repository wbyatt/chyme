import type {
  ExtractedReference,
  ThreadDetail,
  ThreadSummary,
  SourceRef,
  ThreadRef,
} from '../../domain/types.js';
import type { FetchDetailOptions, SourceDriver, ListThreadsOptions } from '../types.js';
import { DriverError, NotImplementedError } from '../../util/errors.js';
import type { GitHubClient } from './client.js';
import { mapIssueDetail, mapIssueSummary, mapPullRequestDetail, mapPullRequestSummary } from './map.js';
import type {
  GitHubChangedFile,
  GitHubIssueComment,
  GitHubPullRequestCommit,
  GitHubRestFile,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewWithComments,
  GraphQlConnection,
  IssueCommentsPageResponse,
  IssueDetailResponse,
  ListIssuesResponse,
  ListPullRequestsResponse,
  PullRequestCommentsPageResponse,
  PullRequestCommitsPageResponse,
  PullRequestDetailResponse,
  PullRequestFilesPageResponse,
  PullRequestReviewsPageResponse,
  ReviewCommentsPageResponse,
} from './payload.js';
import { connectionNodes } from './payload.js';
import * as Q from './queries.js';
import { extractReferences } from './references.js';
import { describeSource, parseSourceKey, splitSourceKey } from './source-key.js';
import type { GitHubRepo } from './source-key.js';

const DRIVER_ID = 'github';

/**
 * A runaway guard, not a limit. At 100 items a page this is 100,000 of
 * anything, which no real thread and no real week of a repository produces —
 * so tripping it means a cursor is not advancing, and stopping loudly beats
 * paginating forever or truncating quietly.
 */
const MAX_PAGES = 1000;

const REST_PAGE_SIZE = 100;

interface Page<T> {
  nodes: T[];
  after: string | null;
}

function pageOf<T>(connection: GraphQlConnection<T> | null | undefined): Page<T> {
  if (!connection) return { nodes: [], after: null };
  return {
    nodes: connectionNodes(connection),
    after: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
  };
}

/**
 * Continue a connection whose first page is already in hand.
 *
 * The first page always arrives inside a larger query — the thread detail, the
 * review that owns these comments — so pagination starts from a value rather
 * than from a cursor, and only the continuation needs a document of its own.
 */
async function drain<T>(
  first: GraphQlConnection<T> | null | undefined,
  next: (after: string) => Promise<GraphQlConnection<T> | null | undefined>,
  what: string,
): Promise<T[]> {
  const page = pageOf(first);
  const nodes = page.nodes;
  let after = page.after;

  for (let visited = 1; after !== null; visited += 1) {
    if (visited >= MAX_PAGES) {
      throw new DriverError(
        `GitHub kept paging ${what} past ${MAX_PAGES} pages.`,
        DRIVER_ID,
        'This almost certainly means a cursor stopped advancing rather than that the data is real. Please report it.',
      );
    }
    const cursor = after;
    const continued = pageOf(await next(cursor));
    nodes.push(...continued.nodes);
    // A cursor that does not move would otherwise spin until MAX_PAGES.
    after = continued.after === cursor ? null : continued.after;
  }

  return nodes;
}

export class GitHubDriver implements SourceDriver {
  readonly id = DRIVER_ID;
  readonly #client: GitHubClient;

  constructor(client: GitHubClient) {
    this.#client = client;
  }

  parseSourceKey(input: string): string {
    return parseSourceKey(input);
  }

  describeSource(key: string): string {
    return describeSource(key);
  }

  extractReferences(text: string): ExtractedReference[] {
    return extractReferences(text);
  }

  /**
   * GitHub can only order these connections descending-by-recency in a form
   * that is complete and consistent, while sync needs them ascending. So the
   * window is paged newest-first until it crosses the watermark, buffered, and
   * then handed back oldest-first.
   *
   * The buffer is the cost of that inversion, and it is a real one: an
   * unbounded first sync of a busy repository holds every summary in memory at
   * once. At the scale this tool is for — low double-digit threads a week — it
   * is nothing, and it buys correct resumption, which the alternative
   * (`search`, capped at 1000 results and eventually consistent) cannot offer
   * at any price.
   */
  async *listThreadsUpdatedSince(
    source: SourceRef,
    opts: ListThreadsOptions,
  ): AsyncIterable<ThreadSummary> {
    const repo = splitSourceKey(source.key);
    const kinds = new Set(opts.kinds);

    if (kinds.has('discussion')) {
      throw new NotImplementedError(
        'GitHub Discussions — remove "discussion" from this source\'s kinds',
      );
    }

    const since = opts.since === null ? null : Date.parse(opts.since);
    if (since !== null && Number.isNaN(since)) {
      throw new DriverError(`Unreadable watermark "${opts.since}".`, DRIVER_ID);
    }

    const window: ThreadSummary[] = [];
    if (kinds.has('pull_request')) {
      window.push(
        ...(await this.#listWindow(
          since,
          'pull requests',
          async (after) => {
            const response = await this.#client.graphql<ListPullRequestsResponse>(
              Q.LIST_PULL_REQUESTS,
              { ...repo, first: Q.PAGE_SIZE.threads, after },
              opts.signal,
            );
            if (!response.repository) throw this.#missingRepository(repo);
            return response.repository.pullRequests;
          },
          mapPullRequestSummary,
          opts.signal,
        )),
      );
    }
    if (kinds.has('issue')) {
      window.push(
        ...(await this.#listWindow(
          since,
          'issues',
          async (after) => {
            const response = await this.#client.graphql<ListIssuesResponse>(
              Q.LIST_ISSUES,
              { ...repo, first: Q.PAGE_SIZE.threads, after },
              opts.signal,
            );
            if (!response.repository) throw this.#missingRepository(repo);
            return response.repository.issues;
          },
          mapIssueSummary,
          opts.signal,
        )),
      );
    }

    // Pull requests and issues are paged separately but must come out as one
    // ascending stream, or the sync cursor would jump backwards between kinds.
    window.sort((left, right) => {
      const delta = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (delta !== 0) return delta;
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
      return left.number - right.number;
    });

    for (const summary of window) {
      opts.signal?.throwIfAborted();
      yield summary;
    }
  }

  /**
   * Page a newest-first connection until it drops below the watermark.
   *
   * Because the order is guaranteed descending, the *first* thread older than
   * the watermark ends the walk: everything behind it is older still. That is
   * what keeps an incremental sync to one or two requests however long the
   * repository's history is.
   */
  async #listWindow<TNode>(
    since: number | null,
    what: string,
    fetchPage: (after: string | null) => Promise<GraphQlConnection<TNode>>,
    map: (node: TNode) => ThreadSummary,
    signal?: AbortSignal,
  ): Promise<ThreadSummary[]> {
    const collected: ThreadSummary[] = [];
    let after: string | null = null;

    for (let visited = 0; visited < MAX_PAGES; visited += 1) {
      signal?.throwIfAborted();
      // Annotated because `after` is fed by `page.after` on the next turn of
      // the loop, and inference will not chase its own tail.
      const page: Page<TNode> = pageOf(await fetchPage(after));

      for (const node of page.nodes) {
        const summary = map(node);
        if (since !== null && Date.parse(summary.updatedAt) < since) return collected;
        collected.push(summary);
      }

      // A cursor that stops moving would otherwise spin until MAX_PAGES.
      if (page.after === null || page.after === after) return collected;
      after = page.after;
    }

    throw new DriverError(
      `GitHub kept paging ${what} past ${MAX_PAGES} pages.`,
      DRIVER_ID,
      'This almost certainly means a cursor stopped advancing rather than that the data is real. Please report it.',
    );
  }

  async fetchThreadDetail(
    source: SourceRef,
    ref: ThreadRef,
    opts: FetchDetailOptions,
  ): Promise<ThreadDetail> {
    const repo = splitSourceKey(source.key);
    if (ref.kind === 'discussion') {
      throw new NotImplementedError('GitHub Discussions');
    }
    return ref.kind === 'issue'
      ? this.#fetchIssue(repo, ref.number, opts)
      : this.#fetchPullRequest(repo, ref.number, opts);
  }

  async #fetchPullRequest(
    repo: GitHubRepo,
    number: number,
    opts: FetchDetailOptions,
  ): Promise<ThreadDetail> {
    const scope = { owner: repo.owner, name: repo.name, number };
    const response = await this.#client.graphql<PullRequestDetailResponse>(
      Q.PULL_REQUEST_DETAIL,
      scope,
      opts.signal,
    );

    const node = response.repository?.pullRequest;
    if (!node) throw this.#missingThread(repo, 'pull request', number);

    const [comments, reviews, commits, files] = await Promise.all([
      drain<GitHubIssueComment>(
        node.comments,
        async (after) =>
          (
            await this.#client.graphql<PullRequestCommentsPageResponse>(
              Q.PULL_REQUEST_COMMENTS_PAGE,
              { ...scope, after },
              opts.signal,
            )
          ).repository?.pullRequest?.comments,
        'comments',
      ),
      drain<GitHubReview>(
        node.reviews,
        async (after) =>
          (
            await this.#client.graphql<PullRequestReviewsPageResponse>(
              Q.PULL_REQUEST_REVIEWS_PAGE,
              { ...scope, after },
              opts.signal,
            )
          ).repository?.pullRequest?.reviews,
        'reviews',
      ),
      drain<GitHubPullRequestCommit>(
        node.commits,
        async (after) =>
          (
            await this.#client.graphql<PullRequestCommitsPageResponse>(
              Q.PULL_REQUEST_COMMITS_PAGE,
              { ...scope, after },
              opts.signal,
            )
          ).repository?.pullRequest?.commits,
        'commits',
      ),
      drain<GitHubChangedFile>(
        node.files,
        async (after) =>
          (
            await this.#client.graphql<PullRequestFilesPageResponse>(
              Q.PULL_REQUEST_FILES_PAGE,
              { ...scope, after },
              opts.signal,
            )
          ).repository?.pullRequest?.files,
        'changed files',
      ),
    ]);

    // Fanning out over reviews looks reckless against GitHub's concurrency
    // limits, but `drain` issues no request at all for a review whose inline
    // comments fit one page, which is almost all of them. The requests that do
    // happen are the handful of reviews with a hundred-odd comments.
    const withComments = await Promise.all(
      reviews.map((review) => this.#completeReview(review, opts.signal)),
    );

    return mapPullRequestDetail({
      node,
      comments,
      reviews: withComments,
      commits,
      files: {
        files,
        patches: opts.includePatches
          ? await this.#fetchPatches(repo, number, opts.signal)
          : null,
        maxPatchBytes: opts.maxPatchBytes,
      },
    });
  }

  /** Most reviews carry a handful of inline comments; a few carry hundreds. */
  async #completeReview(
    review: GitHubReview,
    signal?: AbortSignal,
  ): Promise<GitHubReviewWithComments> {
    const comments = await drain<GitHubReviewComment>(
      review.comments,
      async (after) =>
        (
          await this.#client.graphql<ReviewCommentsPageResponse>(
            Q.REVIEW_COMMENTS_PAGE,
            { id: review.id, after },
            signal,
          )
        ).node?.comments,
      'review comments',
    );
    return { review, comments };
  }

  /**
   * The REST detour for patch text. GraphQL has no field for it at all, so this
   * is the only way to get a hunk out of GitHub, and it is why a driver that is
   * otherwise entirely GraphQL keeps a REST client around.
   */
  async #fetchPatches(
    repo: GitHubRepo,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubRestFile[]> {
    const collected: GitHubRestFile[] = [];
    const lastPage = Math.ceil(Q.REST_FILES_HARD_CAP / REST_PAGE_SIZE);

    for (let page = 1; page <= lastPage; page += 1) {
      signal?.throwIfAborted();
      const { data } = await this.#client.rest<GitHubRestFile[]>(
        Q.REST_PULL_REQUEST_FILES,
        {
          owner: repo.owner,
          repo: repo.name,
          pull_number: number,
          per_page: REST_PAGE_SIZE,
          page,
        },
        signal,
      );
      collected.push(...data);
      if (data.length < REST_PAGE_SIZE) break;
    }

    // Past this point GitHub simply stops listing files. The shortfall is not
    // an error and not silence: mapFileChanges marks every file it could not
    // pair with a patch as truncated, using the GraphQL list as the spine.
    return collected;
  }

  async #fetchIssue(
    repo: GitHubRepo,
    number: number,
    opts: FetchDetailOptions,
  ): Promise<ThreadDetail> {
    const scope = { owner: repo.owner, name: repo.name, number };
    const response = await this.#client.graphql<IssueDetailResponse>(
      Q.ISSUE_DETAIL,
      scope,
      opts.signal,
    );

    const node = response.repository?.issue;
    if (!node) throw this.#missingThread(repo, 'issue', number);

    const comments = await drain<GitHubIssueComment>(
      node.comments,
      async (after) =>
        (
          await this.#client.graphql<IssueCommentsPageResponse>(
            Q.ISSUE_COMMENTS_PAGE,
            { ...scope, after },
            opts.signal,
          )
        ).repository?.issue?.comments,
      'comments',
    );

    // No files fetched, and none to fetch: an issue has no diff.
    return mapIssueDetail({ node, comments });
  }

  #missingRepository(repo: GitHubRepo): DriverError {
    return new DriverError(
      `GitHub has no repository ${repo.owner}/${repo.name} that this token can see.`,
      DRIVER_ID,
      'Check the source key for a typo, and that the token has access if the repository is private.',
    );
  }

  #missingThread(repo: GitHubRepo, what: string, number: number): DriverError {
    return new DriverError(
      `GitHub has no ${what} #${number} in ${repo.owner}/${repo.name}.`,
      DRIVER_ID,
      'It may have been deleted or transferred to another repository.',
    );
  }
}
