import { describe, expect, it } from 'vitest';
import type { ForgeEvent } from '../../domain/types.js';
import {
  isBot,
  mapActor,
  mapFileChanges,
  mapIssueDetail,
  mapIssueSummary,
  mapPullRequestDetail,
  mapPullRequestSummary,
} from './map.js';
import type {
  GitHubActor,
  GitHubChangedFile,
  GitHubIssueComment,
  GitHubIssueDetailNode,
  GitHubPullRequestCommit,
  GitHubPullRequestDetailNode,
  GitHubRestFile,
  GitHubReview,
  GitHubReviewComment,
} from './payload.js';

/**
 * Fixtures are written out by hand in the shape GitHub actually returns, rather
 * than generated from the mappers, so that a change to a mapper cannot quietly
 * change what the test claims GitHub said.
 */

const HUMAN: GitHubActor = {
  __typename: 'User',
  login: 'rmoss',
  id: 'MDQ6VXNlcjE=',
  name: 'Rae Moss',
};

const APP_BOT: GitHubActor = {
  __typename: 'Bot',
  login: 'dependabot',
  id: 'BOT_kgDOA1b2',
};

const USER_SHAPED_BOT: GitHubActor = {
  __typename: 'User',
  login: 'renovate[bot]',
  id: 'MDQ6VXNlcjI=',
  name: null,
};

function pullRequest(
  overrides: Partial<GitHubPullRequestDetailNode> = {},
): GitHubPullRequestDetailNode {
  return {
    id: 'PR_kwDOABCD1',
    number: 412,
    title: 'Retry the upload on a 502',
    state: 'MERGED',
    isDraft: false,
    url: 'https://github.com/acme/widget/pull/412',
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-22T16:30:00Z',
    closedAt: '2026-07-22T16:30:00Z',
    mergedAt: '2026-07-22T16:30:00Z',
    author: HUMAN,
    mergedBy: HUMAN,
    labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'bug' }] },
    body: 'The uploader gives up too early.',
    comments: null,
    reviews: null,
    commits: null,
    files: null,
    ...overrides,
  };
}

function issue(overrides: Partial<GitHubIssueDetailNode> = {}): GitHubIssueDetailNode {
  return {
    id: 'I_kwDOABCD9',
    number: 88,
    title: 'Uploads fail intermittently',
    state: 'CLOSED',
    stateReason: 'COMPLETED',
    url: 'https://github.com/acme/widget/issues/88',
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-22T16:31:00Z',
    closedAt: '2026-07-22T16:31:00Z',
    author: HUMAN,
    labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    body: 'About one in fifty uploads fails.',
    comments: null,
    ...overrides,
  };
}

const COMMENT: GitHubIssueComment = {
  id: 'IC_kwDO1',
  url: 'https://github.com/acme/widget/pull/412#issuecomment-1',
  createdAt: '2026-07-21T10:00:00Z',
  body: 'Have you tried a longer backoff?',
  author: HUMAN,
};

const INLINE_COMMENT: GitHubReviewComment = {
  id: 'PRRC_kwDO1',
  url: 'https://github.com/acme/widget/pull/412#discussion_r1',
  createdAt: '2026-07-21T11:05:00Z',
  body: 'This retries a 400 too.',
  path: 'src/upload.ts',
  line: 42,
  originalLine: 40,
  outdated: false,
  diffHunk: '@@ -38,6 +38,9 @@',
  replyTo: null,
  author: APP_BOT,
};

const REVIEW: GitHubReview = {
  id: 'PRR_kwDO1',
  url: 'https://github.com/acme/widget/pull/412#pullrequestreview-1',
  state: 'CHANGES_REQUESTED',
  body: 'Nearly there.',
  createdAt: '2026-07-21T11:00:00Z',
  submittedAt: '2026-07-21T11:06:00Z',
  author: HUMAN,
  comments: null,
};

const COMMIT: GitHubPullRequestCommit = {
  id: 'PRC_kwDO1',
  commit: {
    oid: '9f2c1ab4d5e6f70819202122232425262728292a',
    url: 'https://github.com/acme/widget/commit/9f2c1ab',
    message: 'Retry uploads on 502\n\nThe CDN returns 502 under load. Retrying three times\nwith jitter clears it without masking real failures.',
    messageHeadline: 'Retry uploads on 502',
    committedDate: '2026-07-20T09:05:00Z',
    authoredDate: '2026-07-20T08:55:00Z',
    author: { name: 'Rae Moss', email: 'rae@example.com', user: HUMAN },
  },
};

const FILE: GitHubChangedFile = {
  path: 'src/upload.ts',
  additions: 20,
  deletions: 3,
  changeType: 'MODIFIED',
};

function eventsOfKind(events: ForgeEvent[], kind: ForgeEvent['kind']): ForgeEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe('mapActor', () => {
  it('maps a human', () => {
    expect(mapActor(HUMAN)).toEqual({
      externalId: 'MDQ6VXNlcjE=',
      handle: 'rmoss',
      displayName: 'Rae Moss',
      isBot: false,
    });
  });

  it('returns null for a deleted account rather than a placeholder', () => {
    expect(mapActor(null)).toBeNull();
    expect(mapActor(undefined)).toBeNull();
  });

  it('detects a GitHub App by its type', () => {
    expect(isBot(APP_BOT)).toBe(true);
    expect(mapActor(APP_BOT)?.isBot).toBe(true);
  });

  it('detects a bot that posts through a user-shaped account', () => {
    expect(isBot(USER_SHAPED_BOT)).toBe(true);
    expect(mapActor(USER_SHAPED_BOT)?.isBot).toBe(true);
  });

  it('does not mistake a human for a bot', () => {
    expect(isBot(HUMAN)).toBe(false);
    expect(isBot({ __typename: 'User', login: 'robotics-fan', id: 'x' })).toBe(false);
  });

  it('falls back to a login-derived id so upserts stay idempotent', () => {
    expect(mapActor({ __typename: 'Mannequin', login: 'ghost-import' })?.externalId).toBe(
      'login:ghost-import',
    );
  });
});

describe('mapPullRequestSummary', () => {
  it('maps the fields sync decides on', () => {
    expect(mapPullRequestSummary(pullRequest())).toMatchObject({
      externalId: 'PR_kwDOABCD1',
      kind: 'pull_request',
      number: 412,
      state: 'merged',
      isDraft: false,
      updatedAt: '2026-07-22T16:30:00Z',
      labels: ['bug'],
    });
  });

  it('keeps draft orthogonal to state', () => {
    const summary = mapPullRequestSummary(
      pullRequest({ state: 'OPEN', isDraft: true, closedAt: null, mergedAt: null }),
    );
    expect(summary.state).toBe('open');
    expect(summary.isDraft).toBe(true);
  });

  it('survives a deleted author', () => {
    expect(mapPullRequestSummary(pullRequest({ author: null })).author).toBeNull();
  });

  it('retains the raw payload', () => {
    const node = pullRequest();
    expect(mapPullRequestSummary(node).raw).toBe(node);
  });
});

describe('mapIssueSummary', () => {
  it('maps an issue, which is never a draft and never merged', () => {
    const summary = mapIssueSummary(issue());
    expect(summary).toMatchObject({ kind: 'issue', state: 'closed', isDraft: false });
    expect(summary.mergedAt).toBeNull();
  });
});

describe('mapPullRequestDetail', () => {
  const detail = mapPullRequestDetail({
    node: pullRequest(),
    comments: [COMMENT],
    reviews: [{ review: REVIEW, comments: [INLINE_COMMENT] }],
    commits: [COMMIT],
    files: { files: [FILE], patches: null, maxPatchBytes: 1024 },
  });

  it('emits the whole discourse', () => {
    expect(detail.events.map((event) => event.kind).sort()).toEqual([
      'comment',
      'commit',
      'review',
      'review_comment',
      'state_change',
      'state_change',
    ]);
  });

  it('orders events chronologically, because the digest is a narrative', () => {
    const times = detail.events.map((event) => event.createdAt);
    expect(times).toEqual([...times].sort());
  });

  it('puts the review state where a renderer can reach it', () => {
    const [review] = eventsOfKind(detail.events, 'review');
    expect(review?.detail).toMatchObject({ state: 'CHANGES_REQUESTED' });
    expect(review?.createdAt).toBe('2026-07-21T11:06:00Z');
    expect(review?.body).toBe('Nearly there.');
  });

  it('anchors an inline comment to its file and line', () => {
    const [inline] = eventsOfKind(detail.events, 'review_comment');
    expect(inline?.path).toBe('src/upload.ts');
    expect(inline?.line).toBe(42);
    expect(inline?.detail).toMatchObject({ reviewId: 'PRR_kwDO1', diffHunk: '@@ -38,6 +38,9 @@' });
    expect(inline?.actor?.isBot).toBe(true);
  });

  it('leaves the line null on an outdated comment rather than inventing one', () => {
    const outdated = mapPullRequestDetail({
      node: pullRequest(),
      comments: [],
      reviews: [
        {
          review: REVIEW,
          comments: [{ ...INLINE_COMMENT, line: null, originalLine: 40, outdated: true }],
        },
      ],
      commits: [],
      files: { files: [], patches: null, maxPatchBytes: 1024 },
    });
    const [inline] = eventsOfKind(outdated.events, 'review_comment');
    expect(inline?.line).toBeNull();
    expect(inline?.path).toBe('src/upload.ts');
    expect(inline?.detail).toMatchObject({ originalLine: 40, outdated: true });
  });

  it('carries the whole commit message, not the headline', () => {
    const [commit] = eventsOfKind(detail.events, 'commit');
    expect(commit?.body).toContain('The CDN returns 502 under load.');
    expect(commit?.detail).toMatchObject({
      sha: '9f2c1ab4d5e6f70819202122232425262728292a',
      headline: 'Retry uploads on 502',
    });
  });

  it('records a commit whose author matches no GitHub account without an actor', () => {
    const unlinked = mapPullRequestDetail({
      node: pullRequest(),
      comments: [],
      reviews: [],
      commits: [
        {
          ...COMMIT,
          commit: {
            ...COMMIT.commit,
            author: { name: 'Old Laptop', email: 'nobody@localhost', user: null },
          },
        },
      ],
      files: { files: [], patches: null, maxPatchBytes: 1024 },
    });
    const [commit] = eventsOfKind(unlinked.events, 'commit');
    expect(commit?.actor).toBeNull();
    expect(commit?.detail).toMatchObject({ authorName: 'Old Laptop' });
  });

  it('synthesises opened and merged, but not a duplicate close', () => {
    const states = eventsOfKind(detail.events, 'state_change');
    expect(states.map((event) => event.detail?.['transition'])).toEqual(['opened', 'merged']);
    expect(states[1]?.actor?.handle).toBe('rmoss');
  });

  it('synthesises a close when the thread was closed unmerged', () => {
    const abandoned = mapPullRequestDetail({
      node: pullRequest({ state: 'CLOSED', mergedAt: null, mergedBy: null }),
      comments: [],
      reviews: [],
      commits: [],
      files: { files: [], patches: null, maxPatchBytes: 1024 },
    });
    const states = eventsOfKind(abandoned.events, 'state_change');
    expect(states.map((event) => event.detail?.['transition'])).toEqual(['opened', 'closed']);
    // Who closed it lives in the timeline, which is not traversed yet.
    expect(states[1]?.actor).toBeNull();
  });

  it('gives synthesised events stable ids so a re-sync upserts rather than duplicates', () => {
    const again = mapPullRequestDetail({
      node: pullRequest(),
      comments: [COMMENT],
      reviews: [{ review: REVIEW, comments: [INLINE_COMMENT] }],
      commits: [COMMIT],
      files: { files: [FILE], patches: null, maxPatchBytes: 1024 },
    });
    expect(again.events.map((event) => event.externalId)).toEqual(
      detail.events.map((event) => event.externalId),
    );
  });

  it('does not emit label or rename events', () => {
    expect(eventsOfKind(detail.events, 'label')).toEqual([]);
    expect(eventsOfKind(detail.events, 'rename')).toEqual([]);
    // Labels are still captured, as current state on the thread.
    expect(detail.labels).toEqual(['bug']);
  });

  it('treats an empty body as no body', () => {
    const blank = mapPullRequestDetail({
      node: pullRequest({ body: '' }),
      comments: [],
      reviews: [{ review: { ...REVIEW, body: '' }, comments: [] }],
      commits: [],
      files: { files: [], patches: null, maxPatchBytes: 1024 },
    });
    expect(blank.body).toBeNull();
    expect(eventsOfKind(blank.events, 'review')[0]?.body).toBeNull();
  });
});

describe('mapIssueDetail', () => {
  const detail = mapIssueDetail({ node: issue(), comments: [COMMENT] });

  it('has no files, because an issue has no diff', () => {
    expect(detail.files).toEqual([]);
  });

  it('emits opened, closed, and the conversation', () => {
    expect(detail.events.map((event) => event.kind)).toEqual([
      'state_change',
      'comment',
      'state_change',
    ]);
  });

  it('folds the close reason into the closing event', () => {
    const closed = detail.events.at(-1);
    expect(closed?.detail).toMatchObject({ transition: 'closed', stateReason: 'COMPLETED' });
  });

  it('omits a close event for an open issue', () => {
    const open = mapIssueDetail({
      node: issue({ state: 'OPEN', closedAt: null, stateReason: null }),
      comments: [],
    });
    expect(open.events.map((event) => event.detail?.['transition'])).toEqual(['opened']);
  });
});

describe('mapFileChanges', () => {
  const restFile: GitHubRestFile = {
    filename: 'src/upload.ts',
    status: 'modified',
    additions: 20,
    deletions: 3,
    patch: '@@ -38,6 +38,9 @@\n+  await retry(upload);',
  };

  it('attaches the patch when it fits the budget', () => {
    const [change] = mapFileChanges({
      files: [FILE],
      patches: [restFile],
      maxPatchBytes: 65_536,
    });
    expect(change).toEqual({
      path: 'src/upload.ts',
      previousPath: null,
      status: 'modified',
      additions: 20,
      deletions: 3,
      patch: restFile.patch,
      patchTruncated: false,
    });
  });

  it('marks an over-budget patch as truncated and withholds it', () => {
    const [change] = mapFileChanges({
      files: [FILE],
      patches: [{ ...restFile, patch: 'x'.repeat(200) }],
      maxPatchBytes: 100,
    });
    expect(change?.patch).toBeNull();
    expect(change?.patchTruncated).toBe(true);
  });

  it('measures the budget in bytes, not characters', () => {
    // Ten astral-plane characters: ten code points, forty bytes.
    const [change] = mapFileChanges({
      files: [FILE],
      patches: [{ ...restFile, patch: '𝄞'.repeat(10) }],
      maxPatchBytes: 20,
    });
    expect(change?.patchTruncated).toBe(true);
  });

  it('marks a patch GitHub declined to serialise as truncated', () => {
    const withheld: GitHubRestFile = {
      filename: 'generated/schema.json',
      status: 'modified',
      additions: 90_000,
      deletions: 0,
      // GitHub simply omits the key on a file it considers too large.
    };
    const [change] = mapFileChanges({
      files: [
        { path: 'generated/schema.json', additions: 90_000, deletions: 0, changeType: 'MODIFIED' },
      ],
      patches: [withheld],
      maxPatchBytes: 65_536,
    });
    expect(change?.patch).toBeNull();
    expect(change?.patchTruncated).toBe(true);
    // The file itself is still recorded, with its real counts. A withheld patch
    // must never read as a file that was not touched.
    expect(change).toMatchObject({ path: 'generated/schema.json', additions: 90_000 });
  });

  it('treats an explicit null patch the same way', () => {
    const [change] = mapFileChanges({
      files: [FILE],
      patches: [{ ...restFile, patch: null }],
      maxPatchBytes: 65_536,
    });
    expect(change?.patch).toBeNull();
    expect(change?.patchTruncated).toBe(true);
  });

  it('records files past REST’s 3000-file cap as truncated, not as missing', () => {
    const beyond: GitHubChangedFile = {
      path: 'vendor/thing.js',
      additions: 1,
      deletions: 1,
      changeType: 'MODIFIED',
    };
    const changes = mapFileChanges({
      files: [FILE, beyond],
      patches: [restFile],
      maxPatchBytes: 65_536,
    });
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      path: 'vendor/thing.js',
      patch: null,
      patchTruncated: true,
    });
  });

  it('does not claim truncation when patches were never requested', () => {
    const [change] = mapFileChanges({ files: [FILE], patches: null, maxPatchBytes: 65_536 });
    expect(change?.patch).toBeNull();
    // Nothing was withheld: a discourse-only sync did not ask.
    expect(change?.patchTruncated).toBe(false);
  });

  it('takes the previous path of a rename from REST, the only place it exists', () => {
    const [change] = mapFileChanges({
      files: [{ ...FILE, path: 'src/uploader.ts', changeType: 'RENAMED' }],
      patches: [
        {
          filename: 'src/uploader.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          previous_filename: 'src/upload.ts',
          patch: '@@ -1 +1 @@',
        },
      ],
      maxPatchBytes: 65_536,
    });
    expect(change).toMatchObject({
      path: 'src/uploader.ts',
      previousPath: 'src/upload.ts',
      status: 'renamed',
    });
  });

  it('translates GraphQL DELETED into the domain’s removed', () => {
    const [change] = mapFileChanges({
      files: [{ ...FILE, changeType: 'DELETED' }],
      patches: null,
      maxPatchBytes: 65_536,
    });
    expect(change?.status).toBe('removed');
  });

  it('keeps a file REST saw that GraphQL did not', () => {
    const changes = mapFileChanges({
      files: [],
      patches: [{ ...restFile, filename: 'src/orphan.ts' }],
      maxPatchBytes: 65_536,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'src/orphan.ts', patchTruncated: false });
  });
});
