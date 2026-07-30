import type { ActivityResult, ThreadActivity } from '../query/activity.js';
import { byteLength, formatBytes, summarizeBody } from '../util/text.js';
import { BudgetWriter, type RenderOptions } from './budget.js';
import { diffstat, handleList, kindCounts, plural, stamp, threadStatus } from './format.js';

/**
 * The activity index.
 *
 * One block per thread: enough to decide whether to open it, and nothing more.
 * The size hint is the point of the exercise — an agent with a byte budget can
 * see what an expansion costs before spending it.
 */

export const DEFAULT_ACTIVITY_BYTES = 32_768;

/** Longer than this and the one-line summary stops being one line. */
const SUMMARY_CHARS = 160;

/** The writer's block separator, which planning has to charge for to match it. */
const SEPARATOR_BYTES = 2;

export function renderActivity(result: ActivityResult, options: RenderOptions = {}): string {
  const now = options.now ?? new Date();
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_ACTIVITY_BYTES, '\n\n');
  const groups = groupBySource(result.threads);
  // Sized from the worst case — every thread cut and every source left unlisted
  // — so the notices that say what is missing can never themselves be the thing
  // that gets cut.
  writer.reserve(byteLength(footerNotes(result, 0, groups).join('\n')));
  writer.writeFitted(header(result), 'header');

  if (result.threads.length === 0) {
    // An empty window is an answer, not a failure. Saying it plainly stops a
    // reader concluding the query was malformed.
    writer.write('No threads moved in this window.');
    footer(writer, result, 0, []);
    return writer.text();
  }

  const planned = plan(result.threads, groups, now, writer.remaining);

  let shown = 0;
  const unlisted: SourceGroup[] = [];
  for (const group of planned) {
    // A heading and its threads go out as one block. A heading that survived
    // while its threads did not would name a source it does not list, and the
    // count on it is only true once the group's contents are settled.
    if (group.blocks.length > 0 && writer.write(groupBlock(group))) shown += group.blocks.length;
    else unlisted.push(group.source);
  }

  footer(writer, result, shown, unlisted);
  return writer.text();
}

function header(result: ActivityResult): string {
  const { window, totals, project } = result;
  const origin =
    window.sinceOrigin === 'digest' ? ' (since your last saved digest)' : '';

  const lines = [
    `# ${project.slug} activity ${window.since} → ${window.until}${origin}`,
    [
      `${plural(totals.threads, 'thread')} (${totals.newThreads} new, ${totals.ongoingThreads} ongoing)`,
      `${plural(totals.events, 'event')}`,
      `${plural(totals.participants, 'participant')}`,
      `${plural(totals.sources, 'source')}`,
    ].join(' · '),
  ];

  const filters = describeFilters(result);
  if (filters) lines.push(filters);
  return lines.join('\n');
}

function describeFilters(result: ActivityResult): string | null {
  const { filters } = result;
  const parts: string[] = [];
  if (filters.authors.length > 0) parts.push(`authors ${filters.authors.join(', ')}`);
  if (filters.sourceKeys.length > 0) parts.push(`sources ${filters.sourceKeys.join(', ')}`);
  if (filters.paths.length > 0) parts.push(`paths ${filters.paths.join(', ')}`);
  if (filters.kinds.length > 0) parts.push(`kinds ${filters.kinds.join(', ')}`);
  if (filters.includeBots) parts.push('bots included');
  return parts.length > 0 ? `filters: ${parts.join(' · ')}` : null;
}

interface SourceGroup {
  key: string;
  threads: ThreadActivity[];
}

/** Grouped by source, groups ordered by their most recent thread. */
function groupBySource(threads: readonly ThreadActivity[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const activity of threads) {
    const key = activity.source.key;
    const group = groups.get(key);
    if (group) group.threads.push(activity);
    else groups.set(key, { key, threads: [activity] });
  }
  return [...groups.values()];
}

interface PlannedGroup {
  source: SourceGroup;
  /** Thread blocks in recency order; empty when nothing from this source fit. */
  blocks: string[];
}

/**
 * What fits, decided in recency order rather than in layout order.
 *
 * Threads arrive sorted by recency and are laid out by source, and those two
 * orders are not the same one. Writing group by group until the budget binds
 * drops whatever sorted last: a whole source could vanish while older threads
 * from another were shown, under a footer claiming the cut was least recent
 * first. Choosing here and laying out afterwards makes that claim true — what is
 * dropped is a strict tail of the recency order.
 */
function plan(
  threads: readonly ThreadActivity[],
  groups: readonly SourceGroup[],
  now: Date,
  budget: number,
): PlannedGroup[] {
  const planned = new Map<string, PlannedGroup>(
    groups.map((group) => [group.key, { source: group, blocks: [] }]),
  );
  let used = 0;

  for (const activity of threads) {
    const group = planned.get(activity.source.key);
    if (!group) continue;

    // Charged against the longest form the heading can take: once the group's
    // contents are settled the count can only shrink, so the write that follows
    // cannot overrun what was planned for it.
    const heading =
      group.blocks.length === 0
        ? byteLength(partialHeading(group.source, group.source.threads.length)) + SEPARATOR_BYTES
        : 0;

    // The summary line is a courtesy derived from the body — the block still
    // carries the reference and the size hint without it — so it is the first
    // thing dropped when a thread nearly fits.
    let block: string | null = null;
    for (const withSummary of [true, false]) {
      const candidate = threadBlock(activity, now, withSummary);
      if (used + heading + byteLength(candidate) + SEPARATOR_BYTES > budget) continue;
      block = candidate;
      break;
    }

    // Stop rather than skip: letting a smaller, older thread take a larger one's
    // place would make what was dropped something other than the least recent.
    if (block === null) break;

    used += heading + byteLength(block) + SEPARATOR_BYTES;
    group.blocks.push(block);
  }

  return [...planned.values()];
}

function groupBlock(group: PlannedGroup): string {
  const total = group.source.threads.length;
  const heading =
    group.blocks.length === total
      ? `## ${group.source.key} — ${plural(total, 'thread')}`
      : partialHeading(group.source, group.blocks.length);
  return [heading, ...group.blocks].join('\n\n');
}

/**
 * A heading for a group the budget cut into. It states both numbers because a
 * heading reading "10 threads" above four of them is a miscount the reader has
 * no way to catch.
 */
function partialHeading(group: SourceGroup, shown: number): string {
  return `## ${group.key} — ${shown} of ${plural(group.threads.length, 'thread')}`;
}

function threadBlock(activity: ThreadActivity, now: Date, withSummary: boolean): string {
  const { thread, size } = activity;
  const lines = [`${activity.ref} [${threadStatus(thread)}] ${thread.title}`];

  const second = [
    activity.disposition,
    `by ${activity.author?.handle ?? 'unknown'}`,
    `last ${stamp(activity.lastActivityAt, now)}`,
  ];
  const counts = kindCounts(activity.eventCounts);
  if (counts) second.push(counts);
  if (activity.participants.length > 0) {
    second.push(`with ${handleList(activity.participants)}`);
  }
  lines.push(second.join(' · '));

  const third: string[] = [];
  if (activity.diffstat.files > 0) third.push(diffstat(activity.diffstat));
  if (thread.labels.length > 0) third.push(`labels ${thread.labels.join(', ')}`);
  third.push(
    size.diffBytes > 0
      ? `expand ~${formatBytes(size.totalBytes)} (diff ${formatBytes(size.diffBytes)})`
      : `expand ~${formatBytes(size.totalBytes)}`,
  );
  lines.push(third.join(' · '));

  const summary = withSummary ? summarizeBody(thread.body, SUMMARY_CHARS) : null;
  if (summary) lines.push(`> ${summary}`);

  return lines.join('\n');
}

/**
 * Everything the reader would otherwise have to spot for themselves. Silent
 * when nothing was left out, and never silent when something was.
 */
function footer(
  writer: BudgetWriter,
  result: ActivityResult,
  shown: number,
  unlisted: readonly SourceGroup[],
): void {
  const notes = footerNotes(result, shown, unlisted);
  if (notes.length > 0) writer.writeFooter(notes.join('\n'));
}

function footerNotes(
  result: ActivityResult,
  shown: number,
  unlisted: readonly SourceGroup[],
): string[] {
  const notes: string[] = [];

  const dropped = result.threads.length - shown;
  if (dropped > 0) {
    notes.push(
      `[${dropped} of ${result.threads.length} threads not shown, least recent first — raise the byte budget or narrow the window]`,
    );
  }
  if (unlisted.length > 0) {
    // A source that lost every one of its threads leaves no heading behind, and
    // "acme/worker was quiet" and "acme/worker did not fit" are opposite
    // conclusions the reader would otherwise have no way to tell apart.
    const named = unlisted
      .map((group) => `${group.key} (${plural(group.threads.length, 'thread')})`)
      .join(', ');
    notes.push(`[sources not listed: ${named}]`);
  }
  if (result.excluded.botOnly > 0) {
    notes.push(`[${plural(result.excluded.botOnly, 'thread')} excluded: bot activity only]`);
  }
  if (result.excluded.byFilter > 0) {
    notes.push(`[${plural(result.excluded.byFilter, 'thread')} moved but matched no filter]`);
  }

  return notes;
}
