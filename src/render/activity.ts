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

export function renderActivity(result: ActivityResult, options: RenderOptions = {}): string {
  const now = options.now ?? new Date();
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_ACTIVITY_BYTES, '\n\n');
  // Sized from the worst case — every thread cut — so the notices that say what
  // is missing can never themselves be the thing that gets cut.
  writer.reserve(byteLength(footerNotes(result, 0).join('\n')));
  writer.writeFitted(header(result), 'header');

  if (result.threads.length === 0) {
    // An empty window is an answer, not a failure. Saying it plainly stops a
    // reader concluding the query was malformed.
    writer.write('No threads moved in this window.');
    footer(writer, result, 0);
    return writer.text();
  }

  let shown = 0;
  outer: for (const group of groupBySource(result.threads)) {
    const heading = `## ${group.key} — ${plural(group.threads.length, 'thread')}`;
    let headingWritten = false;

    for (const activity of group.threads) {
      // The heading is only worth its bytes if a thread follows it, so it goes
      // out attached to the first block that fits.
      const withHeading = (block: string): string =>
        headingWritten ? block : `${heading}\n\n${block}`;

      // The summary line is a courtesy derived from the body — the block still
      // carries the reference and the size hint without it — so it is the first
      // thing dropped when a thread nearly fits.
      const written =
        writer.write(withHeading(threadBlock(activity, now, true))) ||
        writer.write(withHeading(threadBlock(activity, now, false)));
      if (!written) break outer;

      headingWritten = true;
      shown += 1;
    }
  }

  footer(writer, result, shown);
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
function footer(writer: BudgetWriter, result: ActivityResult, shown: number): void {
  const notes = footerNotes(result, shown);
  if (notes.length > 0) writer.writeFooter(notes.join('\n'));
}

function footerNotes(result: ActivityResult, shown: number): string[] {
  const notes: string[] = [];

  const dropped = result.threads.length - shown;
  if (dropped > 0) {
    notes.push(
      `[${dropped} of ${result.threads.length} threads not shown, least recent first — raise the byte budget or narrow the window]`,
    );
  }
  if (result.excluded.botOnly > 0) {
    notes.push(`[${plural(result.excluded.botOnly, 'thread')} excluded: bot activity only]`);
  }
  if (result.excluded.byFilter > 0) {
    notes.push(`[${plural(result.excluded.byFilter, 'thread')} moved but matched no filter]`);
  }

  return notes;
}
