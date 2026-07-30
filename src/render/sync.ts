import type { SourceSyncReport, SyncReport } from '../sync/sync.js';
import { BudgetWriter, type RenderOptions } from './budget.js';
import { plural } from './format.js';

/**
 * A sync run.
 *
 * Some things must never be quiet: a source that failed, a thread that could not
 * be read, a run that stopped at its thread limit, and a first sync that only
 * reached back so far. Each one means the store is less complete than the next
 * command will imply, and only this output says so.
 *
 * Those lines are therefore written *before* the per-source detail and are
 * exempt from the budget in the sense that the budget is reserved for them
 * first. An earlier version wrote them last and let the budget drop them, which
 * turned a failed sync into output that read as clean.
 */

export const DEFAULT_SYNC_BYTES = 8_192;

export function renderSyncReport(report: SyncReport, options: RenderOptions = {}): string {
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_SYNC_BYTES);

  const written = sum(report.sources, (source) => source.threadsWritten);
  const unchanged = sum(report.sources, (source) => source.threadsUnchanged);
  const events = sum(report.sources, (source) => source.eventsWritten);
  const files = sum(report.sources, (source) => source.filesWritten);

  const warnings = warningLines(report);
  writer.reserve(byteCost(warnings));

  const headline = [
    `${report.projectSlug}: ${plural(written, 'thread')} written`,
    `${unchanged} unchanged`,
    `${plural(events, 'event')}`,
    `${plural(files, 'file')}`,
    duration(report),
  ].join(' · ');
  writer.writeFitted(headline, 'summary');

  // Healthy sources are the detail; they are what yields when space runs short.
  let omittedSources = 0;
  for (const source of report.sources) {
    if (isTroubled(source)) continue;
    if (!writer.write(`  ${sourceLine(source)}`)) omittedSources += 1;
  }
  if (omittedSources > 0) {
    writer.write(`  [${omittedSources} healthy source lines not shown]`);
  }

  if (report.removedSources.length > 0) {
    writer.write(`  removed from config: ${report.removedSources.join(', ')}`);
  }

  writer.release();
  for (const line of warnings) writer.write(line);

  return writer.text();
}

/** Everything the user must see even if nothing else fits. */
function warningLines(report: SyncReport): string[] {
  const lines: string[] = [];

  for (const source of report.sources) {
    if (isTroubled(source)) lines.push(`  ${sourceLine(source)}`);
  }

  for (const source of report.sources) {
    for (const failure of source.failedThreads) {
      lines.push(
        `  ${source.key} ${failure.threadKind} #${failure.number} could not be read: ${failure.error}`,
      );
    }
  }

  const failedSources = report.sources.filter((source) => source.error !== null).length;
  if (failedSources > 0) {
    lines.push(
      `${plural(failedSources, 'source')} failed; the store is missing whatever they hold.`,
    );
  }

  const failedThreads = sum(report.sources, (source) => source.failedThreads.length);
  if (failedThreads > 0) {
    lines.push(
      `${plural(failedThreads, 'thread')} skipped after failing; retry with: chyme sync --since <the updatedAt shown above>`,
    );
  }

  if (report.sources.some((source) => source.hitRunLimit)) {
    lines.push('Stopped at the per-run thread limit; run sync again to continue.');
  }

  const firstSync = report.sources.find((source) => source.firstSyncFrom !== null);
  if (firstSync?.firstSyncFrom) {
    lines.push(
      `First sync read back only to ${firstSync.firstSyncFrom}; reach further with: chyme sync --since <when>`,
    );
  }

  if (report.aborted) {
    lines.push('Interrupted; sources after this point were not attempted.');
  }

  return lines;
}

function isTroubled(source: SourceSyncReport): boolean {
  return source.error !== null || source.failedThreads.length > 0;
}

function sourceLine(source: SourceSyncReport): string {
  const head = `${source.driver} ${source.key}:`;
  if (source.error !== null) return `${head} failed — ${source.error}`;

  const parts = [
    `${source.threadsWritten} written`,
    `${source.threadsUnchanged} unchanged`,
    `${source.eventsWritten} events`,
  ];
  if (source.filesWritten > 0) parts.push(`${source.filesWritten} files`);
  if (source.failedThreads.length > 0) {
    parts.push(`${plural(source.failedThreads.length, 'thread')} skipped`);
  }
  return `${head} ${parts.join(', ')}`;
}

function byteCost(lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  // One separator per line, plus the line itself.
  return lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0);
}

function duration(report: SyncReport): string {
  const ms = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'duration unknown';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
