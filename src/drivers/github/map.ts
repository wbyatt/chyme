import type {
  FileChangeStatus,
  SourceActor,
  SourceEvent,
  FileChange,
  ThreadDetail,
  ThreadSummary,
  ThreadState,
} from '../../domain/types.js';
import type {
  GitHubActor,
  GitHubChangeType,
  GitHubChangedFile,
  GitHubIssueComment,
  GitHubIssueDetailNode,
  GitHubIssueSummary,
  GitHubPullRequestCommit,
  GitHubPullRequestDetailNode,
  GitHubPullRequestSummary,
  GitHubRestFile,
  GitHubReviewComment,
  GitHubReviewWithComments,
} from './payload.js';
import { connectionNodes } from './payload.js';

/**
 * GitHub's vocabulary in, Chyme's out. Everything in this file is pure: it
 * takes payloads that pagination has already assembled and returns domain
 * values, which is what makes the interesting cases — a deleted author, a
 * withheld patch, an outdated inline comment — testable without a network.
 *
 * Nothing here throws on odd data. A thread with a missing author is a thread
 * with a missing author, and saying so is more useful than refusing to record
 * it at all.
 */

const CHANGE_TYPE: Record<GitHubChangeType, FileChangeStatus> = {
  ADDED: 'added',
  CHANGED: 'changed',
  COPIED: 'copied',
  // GraphQL says DELETED where REST says removed; the domain follows REST.
  DELETED: 'removed',
  MODIFIED: 'modified',
  RENAMED: 'renamed',
};

const REST_STATUS: Record<string, FileChangeStatus> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  // REST reports files that appear in the diff without changing. The domain has
  // no word for that, and 'changed' is the closest honest approximation.
  unchanged: 'changed',
};

/**
 * An empty body and no body read identically to a human, and collapsing them
 * saves every renderer downstream from having to. Whitespace-only bodies get
 * the same treatment for the same reason.
 */
function body(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

export function isBot(payload: GitHubActor): boolean {
  // Both signals are needed. `__typename` catches GitHub Apps proper, and the
  // suffix catches the many integrations that post as a User-shaped account.
  return payload.__typename === 'Bot' || payload.login.endsWith('[bot]');
}

/**
 * Null in, null out. GitHub reports a deleted account's authorship as absent,
 * and the domain says so too rather than standing in a "ghost" placeholder that
 * a reader would take for a real participant.
 */
export function mapActor(payload: GitHubActor | null | undefined): SourceActor | null {
  if (!payload) return null;
  return {
    // `id` should always be present, but a login is a stable enough surrogate
    // to keep upserts idempotent if a future actor type has no node id.
    externalId: payload.id ?? `login:${payload.login}`,
    handle: payload.login,
    displayName: payload.name ?? null,
    isBot: isBot(payload),
  };
}

function labels(connection: GitHubPullRequestSummary['labels']): string[] {
  return connectionNodes(connection).map((label) => label.name);
}

function pullRequestState(state: GitHubPullRequestSummary['state']): ThreadState {
  if (state === 'MERGED') return 'merged';
  return state === 'CLOSED' ? 'closed' : 'open';
}

export function mapPullRequestSummary(node: GitHubPullRequestSummary): ThreadSummary {
  return {
    externalId: node.id,
    kind: 'pull_request',
    number: node.number,
    title: node.title,
    state: pullRequestState(node.state),
    isDraft: node.isDraft,
    author: mapActor(node.author),
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    mergedAt: node.mergedAt,
    labels: labels(node.labels),
    raw: node,
  };
}

export function mapIssueSummary(node: GitHubIssueSummary): ThreadSummary {
  return {
    externalId: node.id,
    kind: 'issue',
    number: node.number,
    title: node.title,
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    // Issues have no draft state; the domain keeps the field, GitHub says no.
    isDraft: false,
    author: mapActor(node.author),
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    mergedAt: null,
    labels: labels(node.labels),
    raw: node,
  };
}

function commentEvent(node: GitHubIssueComment): SourceEvent {
  return {
    externalId: node.id,
    kind: 'comment',
    actor: mapActor(node.author),
    createdAt: node.createdAt,
    body: body(node.body),
    path: null,
    line: null,
    detail: { url: node.url },
    raw: node,
  };
}

function reviewCommentEvent(node: GitHubReviewComment, reviewId: string): SourceEvent {
  return {
    externalId: node.id,
    kind: 'review_comment',
    actor: mapActor(node.author),
    createdAt: node.createdAt,
    body: body(node.body),
    path: node.path,
    // GitHub reports no line once the comment is outdated. `originalLine` is
    // deliberately not substituted: it points into a diff that no longer
    // exists, so using it would put the comment on the wrong line of the file.
    line: node.line,
    detail: {
      reviewId,
      url: node.url,
      outdated: node.outdated,
      originalLine: node.originalLine,
      diffHunk: node.diffHunk,
      inReplyTo: node.replyTo?.id ?? null,
    },
    raw: node,
  };
}

function reviewEvents(entry: GitHubReviewWithComments): SourceEvent[] {
  const { review } = entry;
  const events: SourceEvent[] = [
    {
      externalId: review.id,
      kind: 'review',
      actor: mapActor(review.author),
      // A pending review has no submission time; its creation time is the only
      // instant GitHub offers and is close enough to order by.
      createdAt: review.submittedAt ?? review.createdAt,
      body: body(review.body),
      path: null,
      line: null,
      detail: { state: review.state, url: review.url },
      raw: review,
    },
  ];
  for (const comment of entry.comments) {
    events.push(reviewCommentEvent(comment, review.id));
  }
  return events;
}

function commitEvent(node: GitHubPullRequestCommit): SourceEvent {
  const { commit } = node;
  return {
    externalId: node.id,
    kind: 'commit',
    // Unlinked when the commit's author email matches no GitHub account. The
    // git-level name and email go in `detail` rather than being dressed up as
    // an actor, since they identify nobody the forge knows about.
    actor: mapActor(commit.author?.user),
    createdAt: commit.committedDate,
    // The whole message, not the headline. It is frequently the most considered
    // account of the change in the entire thread.
    body: body(commit.message),
    path: null,
    line: null,
    detail: {
      sha: commit.oid,
      headline: commit.messageHeadline,
      url: commit.url,
      authoredAt: commit.authoredDate,
      authorName: commit.author?.name ?? null,
      authorEmail: commit.author?.email ?? null,
    },
    raw: node,
  };
}

/**
 * Opened / closed / merged, read straight off the thread's own timestamps.
 *
 * These three are reliable and already in hand. Reopenings, ready-for-review,
 * label changes and renames all live in `timelineItems`, which is a separate
 * and much larger job; they are simply not emitted yet rather than guessed at.
 * Labels are still captured on the thread itself, so current state is known
 * even though its history is not.
 */
function stateChangeEvents(summary: ThreadSummary, mergedBy: SourceActor | null): SourceEvent[] {
  // Synthesised ids: these events have no node of their own on GitHub, so the
  // key is derived from the thread. Deterministic, which is all upsert needs.
  const events: SourceEvent[] = [
    {
      externalId: `${summary.externalId}:opened`,
      kind: 'state_change',
      actor: summary.author,
      createdAt: summary.createdAt,
      body: null,
      path: null,
      line: null,
      detail: { transition: 'opened', state: 'open' },
      raw: null,
    },
  ];

  if (summary.mergedAt !== null) {
    // A merged pull request also carries a closedAt at the same instant.
    // Emitting both would double-count one action.
    events.push({
      externalId: `${summary.externalId}:merged`,
      kind: 'state_change',
      actor: mergedBy,
      createdAt: summary.mergedAt,
      body: null,
      path: null,
      line: null,
      detail: { transition: 'merged', state: 'merged' },
      raw: null,
    });
  } else if (summary.closedAt !== null) {
    events.push({
      externalId: `${summary.externalId}:closed`,
      kind: 'state_change',
      // Who closed it is only in the timeline, which is not traversed yet.
      actor: null,
      createdAt: summary.closedAt,
      body: null,
      path: null,
      line: null,
      detail: { transition: 'closed', state: 'closed' },
      raw: null,
    });
  }

  return events;
}

/**
 * Chronological, with a stable tiebreak so two syncs of an unchanged thread
 * produce byte-identical output.
 */
function sortEvents(events: SourceEvent[]): SourceEvent[] {
  return events.sort((left, right) => {
    const delta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (delta !== 0) return delta;
    return left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0;
  });
}

export interface PullRequestFileInput {
  /** Every changed file, from GraphQL. Authoritative for which files exist. */
  files: readonly GitHubChangedFile[];
  /**
   * REST rows carrying patch text, or null when patches were not requested.
   * REST stops at 3000 files, so this can cover only part of `files`.
   */
  patches: readonly GitHubRestFile[] | null;
  maxPatchBytes: number;
}

/**
 * Merge the two views of a diff GitHub makes us assemble by hand.
 *
 * GraphQL knows every file but no patch text; REST knows patch text but stops
 * at 3000 files and omits `patch` for individual files it considers too large.
 * Using GraphQL as the spine means a file past REST's cap is still recorded, as
 * a row that says plainly that its patch is missing. A file we know nothing
 * about is a hole in the digest; a file marked `patchTruncated` is a fact.
 */
export function mapFileChanges(input: PullRequestFileInput): FileChange[] {
  const { files, patches, maxPatchBytes } = input;
  const byPath = new Map<string, GitHubRestFile>();
  for (const file of patches ?? []) byPath.set(file.filename, file);

  const changes: FileChange[] = files.map((file) => {
    const rest = byPath.get(file.path);
    byPath.delete(file.path);
    return {
      path: file.path,
      // GraphQL's changed-file connection has no previous path, so a rename
      // only reveals where it came from when REST was consulted too.
      previousPath: rest?.previous_filename ?? null,
      status: CHANGE_TYPE[file.changeType] ?? 'changed',
      additions: file.additions,
      deletions: file.deletions,
      ...resolvePatch(rest, patches !== null, maxPatchBytes),
    };
  });

  // Anything REST saw that GraphQL did not. Should not happen, but a file
  // silently dropped from a diff is exactly the kind of loss worth surviving.
  for (const rest of byPath.values()) {
    changes.push({
      path: rest.filename,
      previousPath: rest.previous_filename ?? null,
      status: REST_STATUS[rest.status] ?? 'changed',
      additions: rest.additions,
      deletions: rest.deletions,
      ...resolvePatch(rest, patches !== null, maxPatchBytes),
    });
  }

  return changes;
}

function resolvePatch(
  rest: GitHubRestFile | undefined,
  patchesRequested: boolean,
  maxPatchBytes: number,
): Pick<FileChange, 'patch' | 'patchTruncated'> {
  // A discourse-only sync never asked for hunks, so nothing was withheld and
  // nothing was truncated. `patchTruncated` means "there is a patch you are not
  // seeing", and claiming that here would send readers looking for it.
  if (!patchesRequested) return { patch: null, patchTruncated: false };

  // Either REST never reached this file (past its 3000-file cap) or it declined
  // to serialise the patch. Both are the same fact to a reader: text exists
  // upstream that is not here.
  if (!rest || rest.patch === undefined || rest.patch === null) {
    return { patch: null, patchTruncated: true };
  }

  if (Buffer.byteLength(rest.patch, 'utf8') > maxPatchBytes) {
    return { patch: null, patchTruncated: true };
  }

  return { patch: rest.patch, patchTruncated: false };
}

export interface PullRequestDetailInput {
  node: GitHubPullRequestDetailNode;
  comments: readonly GitHubIssueComment[];
  reviews: readonly GitHubReviewWithComments[];
  commits: readonly GitHubPullRequestCommit[];
  files: PullRequestFileInput;
}

export function mapPullRequestDetail(input: PullRequestDetailInput): ThreadDetail {
  const summary = mapPullRequestSummary(input.node);
  const events: SourceEvent[] = [
    ...stateChangeEvents(summary, mapActor(input.node.mergedBy)),
    ...input.comments.map(commentEvent),
    ...input.reviews.flatMap(reviewEvents),
    ...input.commits.map(commitEvent),
  ];

  return {
    ...summary,
    body: body(input.node.body),
    events: sortEvents(events),
    files: mapFileChanges(input.files),
  };
}

export interface IssueDetailInput {
  node: GitHubIssueDetailNode;
  comments: readonly GitHubIssueComment[];
}

export function mapIssueDetail(input: IssueDetailInput): ThreadDetail {
  const summary = mapIssueSummary(input.node);
  const events: SourceEvent[] = [
    ...stateChangeEvents(summary, null),
    ...input.comments.map(commentEvent),
  ];

  // stateReason distinguishes "done" from "won't do", which is most of what a
  // closed issue tells a reader. It only exists on the thread, so it is folded
  // into the closing event where a reader will look for it.
  if (input.node.stateReason !== null) {
    const closed = events.find((event) => event.externalId === `${summary.externalId}:closed`);
    if (closed?.detail) closed.detail['stateReason'] = input.node.stateReason;
  }

  return {
    ...summary,
    body: body(input.node.body),
    events: sortEvents(events),
    // Issues do not have a diff. Not "an empty diff" — no diff at all.
    files: [],
  };
}
