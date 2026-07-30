import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtractedReference } from '../../domain/types.js';
import { openStore, type Store } from '../index.js';

const ISSUE_88: ExtractedReference = {
  refKind: 'thread',
  refRaw: '#88',
  hint: { kind: 'issue', number: 88 },
};

const TICKET: ExtractedReference = { refKind: 'ticket', refRaw: 'PROJ-88', hint: null };

let store: Store;

beforeEach(() => {
  store = openStore(':memory:');
});

describe('replaceReferences', () => {
  it('is idempotent on the natural key', () => {
    const first = store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88, TICKET]);
    const second = store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88, TICKET]);

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(store.references.listReferencesFrom({ kind: 'thread', id: 1 })).toHaveLength(2);
  });

  it('records an unresolvable reference rather than dropping it', () => {
    const [ticket] = store.references.replaceReferences({ kind: 'event', id: 7 }, [TICKET]);

    expect(ticket!.refKind).toBe('ticket');
    expect(ticket!.toId).toBeNull();
    expect(ticket!.confidence).toBe(0);
    expect(store.references.listUnresolvedReferences('ticket')).toHaveLength(1);
  });

  it('keeps the driver hint for a later resolution pass', () => {
    const [issue] = store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88]);

    expect(issue!.hint).toEqual({ kind: 'issue', number: 88 });
  });

  it('does not lose a resolution when extraction re-runs', () => {
    const [issue] = store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88]);
    store.references.resolveReference(issue!.id, { kind: 'thread', id: 99 }, 1);

    store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88]);

    const [after] = store.references.listReferencesFrom({ kind: 'thread', id: 1 });
    expect(after!.toKind).toBe('thread');
    expect(after!.toId).toBe(99);
    expect(after!.confidence).toBe(1);
  });

  it('removes an edge the author took back', () => {
    store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88, TICKET]);
    store.references.replaceReferences({ kind: 'thread', id: 1 }, [TICKET]);

    expect(
      store.references.listReferencesFrom({ kind: 'thread', id: 1 }).map((row) => row.refRaw),
    ).toEqual(['PROJ-88']);

    store.references.replaceReferences({ kind: 'thread', id: 1 }, []);
    expect(store.references.listReferencesFrom({ kind: 'thread', id: 1 })).toEqual([]);
  });

  it('keeps thread edges and event edges apart under the same id', () => {
    store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88]);
    store.references.replaceReferences({ kind: 'event', id: 1 }, [TICKET]);

    expect(store.references.listReferencesFrom({ kind: 'thread', id: 1 })).toHaveLength(1);
    expect(store.references.listReferencesFrom({ kind: 'event', id: 1 })).toHaveLength(1);
  });

  it('answers the reverse question', () => {
    const [issue] = store.references.replaceReferences({ kind: 'event', id: 5 }, [ISSUE_88]);
    store.references.resolveReference(issue!.id, { kind: 'thread', id: 99 }, 0.8);

    const inbound = store.references.listReferencesTo('thread', 99);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.from).toEqual({ kind: 'event', id: 5 });
    expect(inbound[0]!.confidence).toBe(0.8);
  });

  it('cleans up on request', () => {
    store.references.replaceReferences({ kind: 'thread', id: 1 }, [ISSUE_88, TICKET]);

    expect(store.references.deleteReferencesFrom({ kind: 'thread', id: 1 })).toBe(2);
    expect(store.references.listReferencesFrom({ kind: 'thread', id: 1 })).toEqual([]);
  });

  it('goes away when the entity it came from does', () => {
    const projectId = store.projects.upsertProject({ slug: 'acme', name: 'Acme' }, 'now').id;
    const sourceId = store.sources.upsertSource(
      { projectId, driver: 'github', key: 'acme/web', kinds: ['pull_request'] },
      'now',
    ).id;
    const thread = store.threads.upsertThread(
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
    );
    const [event] = store.events.upsertEvents(thread.id, sourceId, [
      {
        externalId: 'IC_1',
        kind: 'comment',
        actor: null,
        createdAt: '2026-07-02T10:00:00Z',
        body: 'see #88',
        path: null,
        line: null,
        detail: null,
        raw: null,
      },
    ]);

    store.references.replaceReferences({ kind: 'thread', id: thread.id }, [ISSUE_88]);
    store.references.replaceReferences({ kind: 'event', id: event!.id }, [ISSUE_88]);

    store.threads.deleteThread(thread.id);

    expect(store.references.listReferencesFrom({ kind: 'thread', id: thread.id })).toEqual([]);
    // The event was itself removed by a foreign key cascade, so this only
    // passes because recursive triggers are on.
    expect(store.references.listReferencesFrom({ kind: 'event', id: event!.id })).toEqual([]);
  });
});
