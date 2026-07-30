import type { SourceSyncReport, SyncReport } from '../sync/sync.js';
import { BudgetWriter, type RenderOptions } from './budget.js';
import { plural } from './format.js';

/**
 * A sync run, for a human on stderr.
 *
 * The two things that must never be quiet: a source that failed, and a run that
 * stopped at its thread limit. Either one means the store is less complete than
 * the next command will imply, and only this output says so.
 */

export const DEFAULT_SYNC_BYTES = 8_192;

export function renderSyncReport(report: SyncReport, options: RenderOptions = {}): string {
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_SYNC_BYTES);

  const written = sum(report.sources, (source) => source.threadsWritten);
  const unchanged = sum(report.sources, (source) => source.threadsUnchanged);
  const events = sum(report.sources, (source) => source.eventsWritten);
  const files = sum(report.sources, (source) => source.filesWritten);
  const failed = report.sources.filter((source) => source.error !== null).length;

  const headline = [
    `${report.projectSlug}: ${plural(written, 'thread')} written`,
    `${unchanged} unchanged`,
    `${plural(events, 'event')}`,
    `${plural(files, 'file')}`,
    duration(report),
  ].join(' · ');
  writer.writeFitted(headline, 'summary');

  for (const source of report.sources) {
    writer.write(`  ${sourceLine(source)}`);
  }

  if (report.removedSources.length > 0) {
    writer.write(`  removed from config: ${report.removedSources.join(', ')}`);
  }
  if (failed > 0) {
    writer.write(`${plural(failed, 'source')} failed; the store is missing whatever they hold.`);
  }

  return writer.text();
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
  const limit = source.hitRunLimit
    ? ' — stopped at the per-run thread limit; run sync again to continue'
    : '';
  return `${head} ${parts.join(', ')}${limit}`;
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
