import { beforeEach, describe, expect, it } from 'vitest';
import type { FileChange } from '../../domain/types.js';
import { openStore, type Store } from '../index.js';

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: 10,
    deletions: 2,
    patch: `@@ -1 +1 @@\n-old\n+new in ${path}\n`,
    patchTruncated: false,
    ...overrides,
  };
}

let store: Store;
let threadId: number;

beforeEach(() => {
  store = openStore(':memory:');
  const projectId = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now').id;
  const sourceId = store.sources.upsertSource(
    { projectId, driver: 'github', key: 'acme/web', kinds: ['pull_request'] },
    'now',
  ).id;
  threadId = store.threads.upsertThread(
    sourceId,
    {
      externalId: 'PR_1',
      kind: 'pull_request',
      number: 1,
      title: 'Change',
      state: 'open',
      isDraft: false,
      author: null,
      url: 'https://example.test/1',
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
      closedAt: null,
      mergedAt: null,
      labels: [],
      raw: null,
    },
    'now',
  ).id;
});

describe('replaceFileChanges', () => {
  it('is idempotent and keeps row ids stable', () => {
    const first = store.fileChanges.replaceFileChanges(threadId, [file('a.ts'), file('b.ts')]);
    const second = store.fileChanges.replaceFileChanges(threadId, [file('a.ts'), file('b.ts')]);

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(store.fileChanges.listFileChanges(threadId)).toHaveLength(2);
  });

  it('drops paths that are no longer part of the change', () => {
    store.fileChanges.replaceFileChanges(threadId, [file('a.ts'), file('b.ts')]);
    store.fileChanges.replaceFileChanges(threadId, [file('b.ts'), file('c.ts')]);

    expect(store.fileChanges.listFileChanges(threadId).map((row) => row.path)).toEqual([
      'b.ts',
      'c.ts',
    ]);
  });

  it('updates counts and patch text in place', () => {
    store.fileChanges.replaceFileChanges(threadId, [file('a.ts')]);
    const [updated] = store.fileChanges.replaceFileChanges(threadId, [
      file('a.ts', { additions: 99, deletions: 0, status: 'renamed', previousPath: 'old.ts' }),
    ]);

    expect(updated!.additions).toBe(99);
    expect(updated!.deletions).toBe(0);
    expect(updated!.status).toBe('renamed');
    expect(updated!.previousPath).toBe('old.ts');
    expect(store.fileChanges.countFileChanges(threadId)).toBe(1);
  });

  it('empties the list when the change touches nothing', () => {
    store.fileChanges.replaceFileChanges(threadId, [file('a.ts')]);
    store.fileChanges.replaceFileChanges(threadId, []);

    expect(store.fileChanges.listFileChanges(threadId)).toEqual([]);
  });

  it('keeps a withheld patch distinguishable from an empty one', () => {
    store.fileChanges.replaceFileChanges(threadId, [
      file('huge.lock', { patch: null, patchTruncated: true }),
      file('tiny.ts', { patch: '', patchTruncated: false }),
    ]);

    const [huge, tiny] = store.fileChanges.listFileChanges(threadId);
    expect(huge!.patch).toBeNull();
    expect(huge!.patchTruncated).toBe(true);
    expect(tiny!.patch).toBe('');
    expect(tiny!.patchTruncated).toBe(false);
  });

  it('summaries omit the patch text', () => {
    store.fileChanges.replaceFileChanges(threadId, [file('a.ts')]);
    const [summary] = store.fileChanges.listFileChangeSummaries(threadId);

    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('patch');
    expect(summary!.additions).toBe(10);
  });

  it('deletes with its thread', () => {
    store.fileChanges.replaceFileChanges(threadId, [file('a.ts')]);
    store.threads.deleteThread(threadId);

    expect(store.fileChanges.countFileChanges(threadId)).toBe(0);
  });
});
