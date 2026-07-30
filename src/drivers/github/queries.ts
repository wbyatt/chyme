/**
 * Everything Chyme asks GitHub for, as data.
 *
 * Two decisions are baked into these documents and are worth stating once:
 *
 * Listing uses `repository.pullRequests` / `repository.issues` ordered by
 * UPDATED_AT, never the `search` connection. `search` caps at 1000 results and
 * is eventually consistent, so a busy repo would silently lose threads from a
 * sync — the one failure a digest must not have, because the gap is invisible.
 *
 * Nested connections are fetched one page deep by the detail documents and
 * continued by the dedicated `*_PAGE` documents. Threading four independent
 * cursors through a single document is possible and produces a query nobody
 * can read, let alone change.
 */

/**
 * Page sizes are interpolated into the documents below so a constant and the
 * query that uses it cannot drift apart.
 *
 * Reviews are fetched in smaller pages than comments because each review drags
 * its own inline-comment connection along: 50 x 50 keeps a single request well
 * inside GitHub's node budget even on a review-heavy pull request.
 */
export const PAGE_SIZE = {
  threads: 100,
  comments: 100,
  reviews: 50,
  reviewComments: 50,
  commits: 100,
  files: 100,
  /** A thread with more than this many labels has bigger problems. */
  labels: 50,
} as const;

/**
 * `Actor` does not itself implement `Node`, so the global id has to be picked
 * up from each concrete type. Enumerating them is verbose but is the only form
 * guaranteed valid against the schema.
 *
 * `EnterpriseUserAccount` is deliberately absent: its `id` and `name` require
 * the `read:enterprise` scope, and GitHub rejects the *entire* query for a token
 * without it — so including the fragment would make every ordinary `repo`-scoped
 * token fail against every repository. Verified against the live API. An actor
 * of an unlisted type still yields `__typename` and `login`, and mapActor falls
 * back to the login as a surrogate id.
 */
const ACTOR_FIELDS = `
fragment ActorFields on Actor {
  __typename
  login
  ... on User { id name }
  ... on Bot { id }
  ... on Organization { id name }
  ... on Mannequin { id }
}
`;

const PULL_REQUEST_SUMMARY = `
fragment PullRequestSummary on PullRequest {
  id
  number
  title
  state
  isDraft
  url
  createdAt
  updatedAt
  closedAt
  mergedAt
  author { ...ActorFields }
  mergedBy { ...ActorFields }
  labels(first: ${PAGE_SIZE.labels}) { nodes { name } }
}
`;

const ISSUE_SUMMARY = `
fragment IssueSummary on Issue {
  id
  number
  title
  state
  stateReason
  url
  createdAt
  updatedAt
  closedAt
  author { ...ActorFields }
  labels(first: ${PAGE_SIZE.labels}) { nodes { name } }
}
`;

const ISSUE_COMMENT_FIELDS = `
fragment IssueCommentFields on IssueComment {
  id
  url
  createdAt
  body
  author { ...ActorFields }
}
`;

const REVIEW_COMMENT_FIELDS = `
fragment ReviewCommentFields on PullRequestReviewComment {
  id
  url
  createdAt
  body
  path
  line
  originalLine
  outdated
  diffHunk
  replyTo { id }
  author { ...ActorFields }
}
`;

const REVIEW_FIELDS = `
fragment ReviewFields on PullRequestReview {
  id
  url
  state
  body
  createdAt
  submittedAt
  author { ...ActorFields }
  comments(first: ${PAGE_SIZE.reviewComments}) {
    pageInfo { hasNextPage endCursor }
    nodes { ...ReviewCommentFields }
  }
}
`;

/**
 * The commit message is fetched whole, not just the headline. In this era it is
 * often the most considered prose in the whole thread, and it is the only
 * account of a change written by whoever actually made it.
 */
const COMMIT_FIELDS = `
fragment PullRequestCommitFields on PullRequestCommit {
  id
  commit {
    oid
    url
    message
    messageHeadline
    committedDate
    authoredDate
    author {
      name
      email
      user { ...ActorFields }
    }
  }
}
`;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

export const LIST_PULL_REQUESTS = `
query ChymeListPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: $first
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      ${PAGE_INFO}
      nodes { ...PullRequestSummary }
    }
  }
}
${PULL_REQUEST_SUMMARY}
${ACTOR_FIELDS}
`;

export const LIST_ISSUES = `
query ChymeListIssues($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(
      first: $first
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      ${PAGE_INFO}
      nodes { ...IssueSummary }
    }
  }
}
${ISSUE_SUMMARY}
${ACTOR_FIELDS}
`;

export const PULL_REQUEST_DETAIL = `
query ChymePullRequestDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ...PullRequestSummary
      body
      comments(first: ${PAGE_SIZE.comments}) {
        ${PAGE_INFO}
        nodes { ...IssueCommentFields }
      }
      reviews(first: ${PAGE_SIZE.reviews}) {
        ${PAGE_INFO}
        nodes { ...ReviewFields }
      }
      commits(first: ${PAGE_SIZE.commits}) {
        ${PAGE_INFO}
        nodes { ...PullRequestCommitFields }
      }
      files(first: ${PAGE_SIZE.files}) {
        ${PAGE_INFO}
        nodes { path additions deletions changeType }
      }
    }
  }
}
${PULL_REQUEST_SUMMARY}
${ISSUE_COMMENT_FIELDS}
${REVIEW_FIELDS}
${REVIEW_COMMENT_FIELDS}
${COMMIT_FIELDS}
${ACTOR_FIELDS}
`;

export const PULL_REQUEST_COMMENTS_PAGE = `
query ChymePullRequestComments($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: ${PAGE_SIZE.comments}, after: $after) {
        ${PAGE_INFO}
        nodes { ...IssueCommentFields }
      }
    }
  }
}
${ISSUE_COMMENT_FIELDS}
${ACTOR_FIELDS}
`;

export const PULL_REQUEST_REVIEWS_PAGE = `
query ChymePullRequestReviews($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: ${PAGE_SIZE.reviews}, after: $after) {
        ${PAGE_INFO}
        nodes { ...ReviewFields }
      }
    }
  }
}
${REVIEW_FIELDS}
${REVIEW_COMMENT_FIELDS}
${ACTOR_FIELDS}
`;

export const PULL_REQUEST_COMMITS_PAGE = `
query ChymePullRequestCommits($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: ${PAGE_SIZE.commits}, after: $after) {
        ${PAGE_INFO}
        nodes { ...PullRequestCommitFields }
      }
    }
  }
}
${COMMIT_FIELDS}
${ACTOR_FIELDS}
`;

export const PULL_REQUEST_FILES_PAGE = `
query ChymePullRequestFiles($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${PAGE_SIZE.files}, after: $after) {
        ${PAGE_INFO}
        nodes { path additions deletions changeType }
      }
    }
  }
}
`;

/**
 * Inline comments belonging to one review, addressed by node id: the review is
 * already in hand by the time this is needed, and `node(id:)` avoids replaying
 * the whole reviews connection to reach page two of one review's comments.
 */
export const REVIEW_COMMENTS_PAGE = `
query ChymeReviewComments($id: ID!, $after: String!) {
  node(id: $id) {
    ... on PullRequestReview {
      comments(first: ${PAGE_SIZE.reviewComments}, after: $after) {
        ${PAGE_INFO}
        nodes { ...ReviewCommentFields }
      }
    }
  }
}
${REVIEW_COMMENT_FIELDS}
${ACTOR_FIELDS}
`;

export const ISSUE_DETAIL = `
query ChymeIssueDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ...IssueSummary
      body
      comments(first: ${PAGE_SIZE.comments}) {
        ${PAGE_INFO}
        nodes { ...IssueCommentFields }
      }
    }
  }
}
${ISSUE_SUMMARY}
${ISSUE_COMMENT_FIELDS}
${ACTOR_FIELDS}
`;

export const ISSUE_COMMENTS_PAGE = `
query ChymeIssueComments($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(first: ${PAGE_SIZE.comments}, after: $after) {
        ${PAGE_INFO}
        nodes { ...IssueCommentFields }
      }
    }
  }
}
${ISSUE_COMMENT_FIELDS}
${ACTOR_FIELDS}
`;

/**
 * The one thing GraphQL cannot give us. `PullRequest.files` exposes path,
 * additions, deletions and change type but no patch text at all, so hunks come
 * from REST or not at all.
 */
export const REST_PULL_REQUEST_FILES = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files';

/** GitHub stops listing changed files here, whatever the diff actually contains. */
export const REST_FILES_HARD_CAP = 3000;
