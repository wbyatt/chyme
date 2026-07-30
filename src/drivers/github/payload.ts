/**
 * The shapes GitHub sends back, mirroring the selection sets in queries.ts.
 *
 * These live apart from the documents so that map.ts and its fixtures can type
 * against them without dragging query strings along, and so a fixture that no
 * longer matches the schema fails at compile time rather than at 3am.
 *
 * Optionality here is not defensive padding — every nullable field below is
 * nullable in GitHub's schema. `author` really is null for deleted accounts,
 * `line` really is null on an outdated inline comment, and connection `nodes`
 * really can contain nulls when a single node is inaccessible.
 */

export interface GraphQlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQlConnection<T> {
  pageInfo: GraphQlPageInfo;
  nodes: readonly (T | null)[] | null;
}

/** `__typename` is selected specifically so bots can be told apart from users. */
export interface GitHubActor {
  __typename: string;
  login: string;
  id?: string | null;
  name?: string | null;
}

export interface GitHubLabel {
  name: string;
}

export type GitHubPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type GitHubIssueState = 'OPEN' | 'CLOSED';

export interface GitHubPullRequestSummary {
  id: string;
  number: number;
  title: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: GitHubActor | null;
  mergedBy: GitHubActor | null;
  labels: GraphQlConnection<GitHubLabel> | null;
}

export interface GitHubIssueSummary {
  id: string;
  number: number;
  title: string;
  state: GitHubIssueState;
  stateReason: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: GitHubActor | null;
  labels: GraphQlConnection<GitHubLabel> | null;
}

export interface GitHubIssueComment {
  id: string;
  url: string;
  createdAt: string;
  body: string | null;
  author: GitHubActor | null;
}

export interface GitHubReviewComment {
  id: string;
  url: string;
  createdAt: string;
  body: string | null;
  path: string;
  /** Null once the comment is outdated — the line it referred to is gone. */
  line: number | null;
  originalLine: number | null;
  outdated: boolean;
  diffHunk: string | null;
  replyTo: { id: string } | null;
  author: GitHubActor | null;
}

export interface GitHubReview {
  id: string;
  url: string;
  state: string;
  body: string | null;
  createdAt: string;
  /** Null while a review is still pending; only its own author can see it. */
  submittedAt: string | null;
  author: GitHubActor | null;
  comments: GraphQlConnection<GitHubReviewComment> | null;
}

export interface GitHubCommit {
  oid: string;
  url: string;
  message: string;
  messageHeadline: string;
  committedDate: string;
  authoredDate: string;
  author: {
    name: string | null;
    email: string | null;
    /** Null when the commit's email is not attached to any GitHub account. */
    user: GitHubActor | null;
  } | null;
}

export interface GitHubPullRequestCommit {
  id: string;
  commit: GitHubCommit;
}

export type GitHubChangeType =
  | 'ADDED'
  | 'CHANGED'
  | 'COPIED'
  | 'DELETED'
  | 'MODIFIED'
  | 'RENAMED';

export interface GitHubChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: GitHubChangeType;
}

export interface GitHubPullRequestDetailNode extends GitHubPullRequestSummary {
  body: string | null;
  comments: GraphQlConnection<GitHubIssueComment> | null;
  reviews: GraphQlConnection<GitHubReview> | null;
  commits: GraphQlConnection<GitHubPullRequestCommit> | null;
  files: GraphQlConnection<GitHubChangedFile> | null;
}

export interface GitHubIssueDetailNode extends GitHubIssueSummary {
  body: string | null;
  comments: GraphQlConnection<GitHubIssueComment> | null;
}

/**
 * REST `GET /pulls/{n}/files`. `patch` is absent — not empty — whenever GitHub
 * decides the file is too large to serialize, which is precisely why the domain
 * distinguishes a null patch from an empty one.
 */
export interface GitHubRestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string | null;
  patch?: string | null;
}

/** A review paired with every inline comment on it, once pagination has run. */
export interface GitHubReviewWithComments {
  review: GitHubReview;
  comments: readonly GitHubReviewComment[];
}

/** Response envelopes, named so driver.ts can say what it expects back. */
export interface ListPullRequestsResponse {
  repository: { pullRequests: GraphQlConnection<GitHubPullRequestSummary> } | null;
}

export interface ListIssuesResponse {
  repository: { issues: GraphQlConnection<GitHubIssueSummary> } | null;
}

export interface PullRequestDetailResponse {
  repository: { pullRequest: GitHubPullRequestDetailNode | null } | null;
}

export interface IssueDetailResponse {
  repository: { issue: GitHubIssueDetailNode | null } | null;
}

export interface PullRequestCommentsPageResponse {
  repository: { pullRequest: { comments: GraphQlConnection<GitHubIssueComment> } | null } | null;
}

export interface PullRequestReviewsPageResponse {
  repository: { pullRequest: { reviews: GraphQlConnection<GitHubReview> } | null } | null;
}

export interface PullRequestCommitsPageResponse {
  repository: {
    pullRequest: { commits: GraphQlConnection<GitHubPullRequestCommit> } | null;
  } | null;
}

export interface PullRequestFilesPageResponse {
  repository: { pullRequest: { files: GraphQlConnection<GitHubChangedFile> } | null } | null;
}

export interface ReviewCommentsPageResponse {
  node: { comments: GraphQlConnection<GitHubReviewComment> } | null;
}

export interface IssueCommentsPageResponse {
  repository: { issue: { comments: GraphQlConnection<GitHubIssueComment> } | null } | null;
}

/** Connection nodes arrive sparse; callers almost always want them dense. */
export function connectionNodes<T>(connection: GraphQlConnection<T> | null | undefined): T[] {
  if (!connection?.nodes) return [];
  return connection.nodes.filter((node): node is T => node !== null);
}
