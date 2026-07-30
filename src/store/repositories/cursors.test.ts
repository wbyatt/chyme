import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../index.js';

let store: Store;
let sourceId: number;
let otherSourceId: number;

beforeEach(() => {
  store = openStore(':memory:');
  const projectId = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now').id;
  sourceId = store.sources.upsertSource(
    { projectId, driver: 'github', key: 'acme/web', kinds: ['pull_request', 'issue'] },
    'now',
  ).id;
  otherSourceId = store.sources.upsertSource(
    { projectId, driver: 'github', key: 'acme/api', kinds: ['pull_request'] },
    'now',
  ).id;
});

describe('sync cursors', () => {
  it('round-trips a value', () => {
    expect(store.cursors.getCursorValue(sourceId, 'pull_request')).toBeNull();

    store.cursors.setCursor(sourceId, 'pull_request', '2026-07-02T00:00:00Z', '2026-07-02T00:01:00Z');

    expect(store.cursors.getCursor(sourceId, 'pull_request')).toEqual({
      sourceId,
      kind: 'pull_request',
      value: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:01:00Z',
    });
  });

  it('keeps a watermark per kind and per source', () => {
    store.cursors.setCursor(sourceId, 'pull_request', '2026-07-02T00:00:00Z', 'now');
    store.cursors.setCursor(sourceId, 'issue', '2026-06-01T00:00:00Z', 'now');
    store.cursors.setCursor(otherSourceId, 'pull_request', '2026-05-01T00:00:00Z', 'now');

    expect(store.cursors.listCursors(sourceId).map((row) => [row.kind, row.value])).toEqual([
      ['issue', '2026-06-01T00:00:00Z'],
      ['pull_request', '2026-07-02T00:00:00Z'],
    ]);
    expect(store.cursors.getCursorValue(otherSourceId, 'pull_request')).toBe('2026-05-01T00:00:00Z');
    expect(store.cursors.getCursorValue(otherSourceId, 'issue')).toBeNull();
  });

  it('advances forward only', () => {
    store.cursors.advanceCursor(sourceId, 'pull_request', '2026-07-02T00:00:00Z', 'now');

    const backwards = store.cursors.advanceCursor(
      sourceId,
      'pull_request',
      '2026-07-01T00:00:00Z',
      'later',
    );

    expect(backwards.value).toBe('2026-07-02T00:00:00Z');
    expect(backwards.updatedAt).toBe('now');

    const forwards = store.cursors.advanceCursor(
      sourceId,
      'pull_request',
      '2026-07-09T00:00:00Z',
      'later',
    );
    expect(forwards.value).toBe('2026-07-09T00:00:00Z');
  });

  it('lets an explicit set rewind for a deliberate backfill', () => {
    store.cursors.advanceCursor(sourceId, 'issue', '2026-07-02T00:00:00Z', 'now');
    store.cursors.setCursor(sourceId, 'issue', '2026-01-01T00:00:00Z', 'later');

    expect(store.cursors.getCursorValue(sourceId, 'issue')).toBe('2026-01-01T00:00:00Z');
  });

  it('clears one kind or all of them', () => {
    store.cursors.setCursor(sourceId, 'pull_request', 'a', 'now');
    store.cursors.setCursor(sourceId, 'issue', 'b', 'now');

    expect(store.cursors.clearCursors(sourceId, 'issue')).toBe(1);
    expect(store.cursors.listCursors(sourceId)).toHaveLength(1);

    expect(store.cursors.clearCursors(sourceId)).toBe(1);
    expect(store.cursors.listCursors(sourceId)).toEqual([]);
  });

  it('goes away with its source', () => {
    store.cursors.setCursor(sourceId, 'pull_request', 'a', 'now');
    store.sources.deleteSource(sourceId);

    expect(store.cursors.listCursors(sourceId)).toEqual([]);
  });
});
