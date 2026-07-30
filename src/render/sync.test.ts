import { describe, expect, it } from 'vitest';
import type { SourceSyncReport, SyncReport } from '../sync/sync.js';
import { renderSyncReport } from './sync.js';

function source(overrides: Partial<SourceSyncReport> = {}): SourceSyncReport {
  return {
    driver: 'github',
    key: 'acme/api',
    threadsSeen: 10,
    threadsWritten: 8,
    threadsUnchanged: 2,
    eventsWritten: 40,
    filesWritten: 12,
    hitRunLimit: false,
    firstSyncFrom: null,
    failedThreads: [],
    error: null,
    ...overrides,
  };
}

function report(sources: SourceSyncReport[], overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    projectSlug: 'platform',
    startedAt: '2026-07-27T09:00:00Z',
    finishedAt: '2026-07-27T09:02:10Z',
    sources,
    removedSources: [],
    aborted: false,
    ...overrides,
  };
}

describe('renderSyncReport', () => {
  it('totals the run and breaks it down by source', () => {
    const text = renderSyncReport(
      report([source(), source({ key: 'acme/worker', threadsWritten: 1, eventsWritten: 3 })]),
    );

    expect(text).toContain('platform: 9 threads written · 4 unchanged · 43 events · 24 files · 2m 10s');
    expect(text).toContain('github acme/api: 8 written, 2 unchanged, 40 events, 12 files');
    expect(text).toContain('github acme/worker: 1 written');
  });

  it('never lets a failure pass quietly', () => {
    const text = renderSyncReport(
      report([source(), source({ key: 'acme/legacy', error: 'HTTP 404 Not Found' })]),
    );

    expect(text).toContain('github acme/legacy: failed — HTTP 404 Not Found');
    expect(text).toContain('1 source failed; the store is missing whatever they hold.');
  });

  it('says when the run limit stopped it short', () => {
    const text = renderSyncReport(report([source({ hitRunLimit: true })]));
    expect(text).toContain('Stopped at the per-run thread limit; run sync again to continue.');
  });

  it('lists sources the config dropped', () => {
    const text = renderSyncReport({ ...report([source()]), removedSources: ['github:acme/old'] });
    expect(text).toContain('removed from config: github:acme/old');
  });
});
