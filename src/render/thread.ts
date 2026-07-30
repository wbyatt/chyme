import { orderEventKinds } from '../domain/types.js';
import type {
  IncomingReference,
  OutgoingReference,
  ThreadEvent,
  ThreadFile,
  ThreadView,
} from '../query/thread.js';
import {
  byteLength,
  fence,
  formatBytes,
  truncateToBytesAtLine,
  truncationNotice,
} from '../util/text.js';
import { BudgetWriter, fit, type RenderOptions } from './budget.js';
import {
  detailFlag,
  detailText,
  diffstat,
  eventNoun,
  handleOf,
  plural,
  stamp,
  threadStatus,
} from './format.js';

/**
 * One thread, expanded.
 *
 * Budget allocation is the whole design of this file. Discussion is the product
 * — it is where the argument, the objection and the pain point live — so when
 * the budget binds, comments and reviews are paid before diff hunks, and
 * whatever is cut is named at the bottom.
 */

export const DEFAULT_THREAD_BYTES = 65_536;

/** The opening description is context, not content; it gets a quarter at most. */
const BODY_SHARE = 0.25;
/** The diff may claim this much of what is left, and only if it needs it. */
const DIFF_SHARE = 0.3;
/** A comment's fair share never drops below this while there is room for it. */
const MIN_EVENT_BYTES = 512;
const MIN_FILE_BYTES = 512;
/** Under this there is no room for even a header line, so the section stops. */
const STOP_BYTES = 96;
/** A description shorter than this after cutting says less than the notice would. */
const MIN_BODY_BYTES = 240;
/** A thread with a hundred references would otherwise bury its own header. */
const MAX_REFS = 12;
/** What a cut comment's notice calls itself, named once so it can be sized. */
const COMMENT = 'this comment';
/** `fit`'s own allowance, for the same reason: `formatBytes` is not monotonic. */
const NOTICE_SLACK = 8;
/** The newlines joining a cut comment's head, body, closing fence and notice. */
const JOIN_BYTES = 3;

interface Section {
  text: string;
  shown: number;
  total: number;
}

export function renderThread(view: ThreadView, options: RenderOptions = {}): string {
  const now = options.now ?? new Date();
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_THREAD_BYTES, '\n\n');
  // The worst case: nothing shown at all. Reserving it means the notices that
  // say what is missing are never themselves the thing that goes missing.
  writer.reserve(
    byteLength(
      footerNotes(
        view,
        { text: '', shown: 0, total: view.events.length },
        { text: '', shown: 0, total: view.files.length },
        false,
      ).join('\n'),
    ),
  );

  writer.writeFitted(header(view, now), 'thread metadata');

  let bodyShown = view.thread.body === null;
  if (view.thread.body) {
    const budget = Math.floor(writer.remaining * BODY_SHARE);
    // Below the floor the section is a heading and an ellipsis, which tells the
    // reader nothing the footer cannot tell them in fewer bytes.
    if (budget >= MIN_BODY_BYTES) {
      const body = fit(view.thread.body, budget, 'description');
      bodyShown = writer.write(`## Description\n\n${body.text}`);
    }
  }

  const rest = writer.remaining;
  const diffNeeded = view.diffsIncluded ? diffSize(view.files) : 0;
  // The diff takes its share only if it can use it; anything it does not need
  // stays with the discussion rather than going unspent.
  const diffBudget = Math.min(diffNeeded, Math.floor(rest * DIFF_SHARE));

  const discussion = renderDiscussion(view.events, Math.max(0, rest - diffBudget - 32));
  if (discussion.text !== '') {
    writer.write(`## Discussion (${plural(view.totals.events, 'event')})\n\n${discussion.text}`);
  }

  const diff =
    view.diffsIncluded && view.files.length > 0
      ? renderDiff(view.files, Math.max(0, writer.remaining - 16))
      : { text: '', shown: 0, total: view.files.length };
  if (diff.text !== '') {
    writer.write(`## Diff\n\n${diff.text}`);
  }

  footer(writer, view, discussion, diff, bodyShown);
  return writer.text();
}

function header(view: ThreadView, now: Date): string {
  const { thread } = view;
  const lines = [
    `# ${view.ref} ${thread.title}`,
    [
      threadStatus(thread),
      `by ${handleOf(view.author)}`,
      `opened ${stamp(thread.createdAt, now)}`,
      `updated ${stamp(thread.updatedAt, now)}`,
    ].join(' · '),
    thread.url,
  ];

  const facts = [
    plural(view.totals.events, 'event'),
    plural(view.totals.participants, 'participant'),
  ];
  if (view.totals.files > 0) facts.push(diffstat(view.totals));
  if (thread.labels.length > 0) facts.push(`labels ${thread.labels.join(', ')}`);
  if (thread.mergedAt) facts.push(`merged ${thread.mergedAt}`);
  else if (thread.closedAt) facts.push(`closed ${thread.closedAt}`);
  lines.push(facts.join(' · '));

  const out = outgoingLine(view.referencesOut);
  if (out) lines.push(out);
  const incoming = incomingLine(view.referencesIn);
  if (incoming) lines.push(incoming);

  return lines.join('\n');
}

function outgoingLine(references: readonly OutgoingReference[]): string | null {
  if (references.length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of references) {
    const text = entry.target
      ? `${entry.reference.refRaw} → ${entry.target.ref}`
      : `${entry.reference.refRaw} (${entry.reference.refKind}, unresolved)`;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return `refs out: ${truncateList(parts)}`;
}

function incomingLine(references: readonly IncomingReference[]): string | null {
  if (references.length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of references) {
    if (!entry.from) continue;
    const via = entry.fromEvent
      ? ` (${entry.fromEvent.kind} by ${handleOf(entry.fromActor)})`
      : '';
    const text = `${entry.from.ref}${via}`;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.length > 0 ? `refs in: ${truncateList(parts)}` : null;
}

function truncateList(parts: readonly string[]): string {
  if (parts.length <= MAX_REFS) return parts.join(' · ');
  return `${parts.slice(0, MAX_REFS).join(' · ')} · [${parts.length - MAX_REFS} more]`;
}

/**
 * Chronological, and cut from the end when the budget binds.
 *
 * Reading a thread forwards is what makes it a narrative, so the order is never
 * re-sorted by relevance; the footer says how many of the most recent turns are
 * missing so the reader knows the story stops short rather than ending.
 */
function renderDiscussion(events: readonly ThreadEvent[], maxBytes: number): Section {
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;

  for (const [index, entry] of events.entries()) {
    const remaining = maxBytes - used;
    const separator = blocks.length > 0 ? 2 : 0;
    if (remaining < STOP_BYTES) break;

    // Twice an even split: one long comment may take more than its share, but
    // not so much that it eats the rest of the conversation.
    const share = Math.max(MIN_EVENT_BYTES, Math.floor((remaining / (events.length - index)) * 2));
    const block = eventBlock(entry, Math.min(remaining - separator, share));
    const cost = byteLength(block) + separator;
    if (cost > remaining) break;

    blocks.push(block);
    used += cost;
    shown += 1;
  }

  return { text: blocks.join('\n\n'), shown, total: events.length };
}

/**
 * One event, cut to fit with the fences in its body left closed.
 *
 * The body is cut before the notice is appended, for the same reason a patch is
 * cut before it is fenced: a review comment carrying a ```suggestion block — a
 * routine thing to find in one — cut mid-fence leaves the fence open, and then
 * the notice saying the comment was cut and every footer note after it render as
 * code. They survive as text but stop reading as markers, which is the one
 * failure this file exists to prevent.
 */
function eventBlock(entry: ThreadEvent, maxBytes: number): string {
  const head = eventHead(entry);
  const body = entry.event.body;
  if (!body) return fit(head, maxBytes, COMMENT).text;

  const open = unclosedFence(body);
  // Closed whether or not we cut: an author's own unterminated fence would
  // swallow the rest of the output just as thoroughly as one of ours.
  const whole = open ? `${head}\n${body}\n${open}` : `${head}\n${body}`;
  if (byteLength(whole) <= maxBytes) return whole;

  // Everything that has to survive the cut, so the body is charged for the rest:
  // the head, the notice against its worst case, the closing fence the cut may
  // need, and the newlines joining the three of them to it.
  const notice = byteLength(truncationNotice(byteLength(body), COMMENT)) + NOTICE_SLACK;
  const room = maxBytes - byteLength(head) - notice - longestFence(body) - JOIN_BYTES;
  const cut = room > 0 ? truncateToBytesAtLine(body, room) : null;

  if (!cut || cut.text === '') {
    // No room for any of the body. Naming it as gone beats a header standing
    // over nothing, which reads as a comment that said nothing.
    return fit(`${head}\n${truncationNotice(byteLength(body), COMMENT)}`, maxBytes, COMMENT).text;
  }

  const closer = unclosedFence(cut.text);
  const parts = closer ? [head, cut.text, closer] : [head, cut.text];
  parts.push(truncationNotice(cut.omittedBytes, COMMENT));
  return parts.join('\n');
}

/**
 * The fence marker still open at the end of `text`, or null.
 *
 * Markdown's own rule: three or more backticks or tildes open a block, and only
 * a run of the same character, at least as long and with nothing after it,
 * closes it. Reading an opener where there is none would have us append a stray
 * fence and cause the very problem this exists to avoid, so the test is strict.
 */
function unclosedFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const rest = match[2]!;
    if (open === null) {
      // A backtick fence's info string cannot itself contain a backtick.
      if (marker.startsWith('`') && rest.includes('`')) continue;
      open = marker;
    } else if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') {
      open = null;
    }
  }
  return open;
}

/** The longest fence marker in `text`: the most a closing one can cost. */
function longestFence(text: string): number {
  let longest = 0;
  for (const [match] of text.matchAll(/^ {0,3}(?:`{3,}|~{3,})/gm)) {
    longest = Math.max(longest, match.trimStart().length);
  }
  return longest;
}

/** Timestamp, kind, author, then whatever the kind adds. Same shape every time. */
function eventHead(entry: ThreadEvent): string {
  const { event } = entry;
  const head = [`### ${event.createdAt}`, event.kind, `by ${handleOf(entry.actor)}`];
  const detail = eventDetail(entry);
  return detail ? `${head.join(' · ')} · ${detail}` : head.join(' · ');
}

function eventDetail(entry: ThreadEvent): string | null {
  const { event } = entry;
  switch (event.kind) {
    case 'review':
      return detailText(event.detail, 'state');
    case 'review_comment': {
      const where = event.path
        ? `${event.path}${event.line === null ? '' : `:${event.line}`}`
        : null;
      const outdated = detailFlag(event.detail, 'outdated') ? ' (outdated)' : '';
      return where ? `${where}${outdated}` : outdated.trim() || null;
    }
    case 'commit': {
      const sha = detailText(event.detail, 'sha');
      return sha ? sha.slice(0, 10) : null;
    }
    case 'state_change': {
      const transition = detailText(event.detail, 'transition');
      const reason = detailText(event.detail, 'stateReason');
      if (transition && reason) return `${transition} (${reason})`;
      return transition ?? reason;
    }
    default:
      return null;
  }
}

function diffSize(files: readonly ThreadFile[]): number {
  return files.reduce(
    (sum, file) => sum + (file.patch ? byteLength(file.patch) : 0) + byteLength(file.path) + 64,
    0,
  );
}

function renderDiff(files: readonly ThreadFile[], maxBytes: number): Section {
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;

  for (const [index, file] of files.entries()) {
    const remaining = maxBytes - used;
    const separator = blocks.length > 0 ? 2 : 0;
    if (remaining < STOP_BYTES) break;

    const share = Math.max(MIN_FILE_BYTES, Math.floor((remaining / (files.length - index)) * 2));
    const block = fileBlock(file, Math.min(remaining - separator, share));
    const cost = byteLength(block) + separator;
    if (cost > remaining) break;

    blocks.push(block);
    used += cost;
    shown += 1;
  }

  return { text: blocks.join('\n\n'), shown, total: files.length };
}

/**
 * The patch is cut before it is fenced, never after: a fence closed by the
 * budget instead of by the renderer leaves everything below it looking like
 * code.
 */
function fileBlock(file: ThreadFile, maxBytes: number): string {
  const rename = file.previousPath ? ` (was ${file.previousPath})` : '';
  const head = `### ${file.path}${rename} · ${file.status} +${file.additions} -${file.deletions}`;

  if (!file.patch) {
    // "No patch" and "we do not have the patch" are opposite conclusions; the
    // store keeps them apart and so must this.
    const why = file.patchTruncated
      ? '[patch withheld by the source or over the sync byte cap]'
      : '[no diff hunk recorded]';
    return `${head}\n${why}`;
  }

  const patch = file.patch.trimEnd();
  // The fence lines, the language tag and the notice that may follow them.
  const overhead = byteLength(head) + 64;
  const cut = truncateToBytesAtLine(patch, Math.max(0, maxBytes - overhead));
  const fenced = `${head}\n${fence(cut.text, 'diff')}`;
  return cut.truncated ? `${fenced}\n${truncationNotice(cut.omittedBytes, 'this patch')}` : fenced;
}

function footer(
  writer: BudgetWriter,
  view: ThreadView,
  discussion: Section,
  diff: Section,
  bodyShown: boolean,
): void {
  const notes = footerNotes(view, discussion, diff, bodyShown);
  if (notes.length > 0) writer.writeFooter(notes.join('\n'));
}

function footerNotes(
  view: ThreadView,
  discussion: Section,
  diff: Section,
  bodyShown: boolean,
): string[] {
  const notes: string[] = [];

  const droppedEvents = discussion.total - discussion.shown;
  if (droppedEvents > 0) {
    notes.push(
      `[${droppedEvents} of ${discussion.total} events not shown, most recent first — raise the byte budget]`,
    );
  }
  if (!bodyShown && view.thread.body) {
    notes.push(`[description not shown: ${formatBytes(byteLength(view.thread.body))}]`);
  }

  for (const kind of orderEventKinds(Object.keys(view.omittedEvents))) {
    const count = view.omittedEvents[kind];
    if (!count) continue;
    notes.push(`[${eventNoun(kind, count)} withheld by the options given]`);
  }

  if (view.diffsIncluded) {
    const droppedFiles = diff.total - diff.shown;
    if (droppedFiles > 0) {
      notes.push(`[${droppedFiles} more ${droppedFiles === 1 ? 'file' : 'files'} not shown]`);
    }
  } else if (view.files.length > 0) {
    notes.push(diffNotShown(view));
  }

  return notes;
}

/**
 * What `--diff` would add, as far as a view without the patches can establish.
 *
 * Which is less than it looks. A diffless view carries file summaries, so
 * whether a hunk is stored at all is knowable only for the files sync marked
 * `patchTruncated`, and the size of one that is stored is not knowable here at
 * all. This used to quote `(additions + deletions) * 40`, which advertised
 * 392 KB for a thread whose `--diff` emits 2 KB of "[no diff hunk recorded]",
 * and 193 B for one that emits 3 KB. A number that wrong is worse than none: it
 * is read as a measurement, and it contradicts `chyme activity`, which sizes the
 * stored patches in the query and is accurate.
 */
function diffNotShown(view: ThreadView): string {
  const stat = diffstat(view.totals);
  const hunkless = view.files.filter((file) => file.patchTruncated).length;

  if (hunkless === view.files.length) {
    return `[diff not shown: ${stat} — no hunks stored, --diff would add file headers only]`;
  }

  const missing = hunkless > 0 ? `, ${plural(hunkless, 'file')} with no stored hunk` : '';
  return `[diff not shown: ${stat}${missing} — pass --diff; size not known here, chyme activity reports it]`;
}
