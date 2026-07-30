import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveThreadRef } from '../query/refs.js';
import { queryThread, type ThreadViewOptions } from '../query/thread.js';
import { actor, createFixture, type Fixture } from '../testing/fixtures.js';
import { byteLength } from '../util/text.js';
import { renderThread } from './thread.js';

const NOW = new Date('2026-07-27T00:00:00Z');
const ADA = actor('ada');
const KAI = actor('kai');

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ sources: ['acme/api'] });
  fixture.addThread({
    number: 412,
    title: 'Add a rate limiter',
    createdAt: '2026-07-01T09:00:00Z',
    author: ADA,
    labels: ['performance'],
    body: 'Token bucket in front of the ingest path, sized for the current peak.',
    events: [
      {
        at: '2026-07-01T09:00:00Z',
        kind: 'state_change',
        by: ADA,
        body: null,
        detail: { transition: 'opened' },
      },
      { at: '2026-07-22T08:00:00Z', by: KAI, body: 'Refill looks too aggressive under burst.' },
      {
        at: '2026-07-23T08:00:00Z',
        kind: 'review',
        by: KAI,
        body: 'Nearly there.',
        detail: { state: 'CHANGES_REQUESTED' },
      },
      {
        at: '2026-07-23T08:05:00Z',
        kind: 'review_comment',
        by: KAI,
        body: 'This constant wants a name.',
        path: 'src/limiter.ts',
        line: 42,
      },
      {
        at: '2026-07-24T10:00:00Z',
        kind: 'commit',
        by: ADA,
        body: 'Name the refill constant',
        detail: { sha: 'abcdef1234567890' },
      },
    ],
    files: [
      { path: 'src/limiter.ts', additions: 120, deletions: 3, patch: `@@ -1,3 +1,5 @@\n${'+line\n'.repeat(60)}` },
      { path: 'src/ingest.ts', additions: 4, deletions: 1, patch: null, patchTruncated: true },
      { path: 'docs/limits.md', additions: 9, deletions: 0, patch: `@@ -1 +1,9 @@\n${'+doc\n'.repeat(40)}` },
    ],
  });
});

afterEach(() => fixture.close());

function render(options: ThreadViewOptions = {}, maxBytes?: number): string {
  const view = queryThread(
    fixture.store,
    resolveThreadRef(fixture.store, 'platform/acme/api#412'),
    options,
  );
  return renderThread(view, { now: NOW, ...(maxBytes === undefined ? {} : { maxBytes }) });
}

describe('renderThread', () => {
  it('lays out metadata, body, the event stream, then the diff', () => {
    const text = render({ includeDiffs: true });

    expect(text).toContain('# platform/acme/api#412 Add a rate limiter');
    expect(text).toContain('pull_request open · by ada · opened 2026-07-01T09:00:00Z');
    expect(text).toContain('5 events · 2 participants · 3 files +133 -4 · labels performance');
    expect(text.indexOf('## Description')).toBeLessThan(text.indexOf('## Discussion'));
    expect(text.indexOf('## Discussion')).toBeLessThan(text.indexOf('## Diff'));

    // Chronological, with authorship, timestamps and the kind-specific detail.
    const order = ['state_change · by ada', 'comment · by kai', 'review · by kai · CHANGES_REQUESTED', 'review_comment · by kai · src/limiter.ts:42', 'commit · by ada · abcdef1234'];
    let cursor = -1;
    for (const fragment of order) {
      const at = text.indexOf(fragment);
      expect(at, fragment).toBeGreaterThan(cursor);
      cursor = at;
    }

    expect(text).toContain('```diff');
    // A patch we do not have never reads as a file with no changes.
    expect(text).toContain('[patch withheld by the source or over the sync byte cap]');
  });

  it('spends a binding budget on discussion before diff hunks', () => {
    const text = render({ includeDiffs: true }, 1600);

    expect(byteLength(text)).toBeLessThanOrEqual(1600);
    // Every comment survives; the diff is what gets cut, and says so.
    expect(text).toContain('Refill looks too aggressive under burst.');
    expect(text).toContain('This constant wants a name.');
    expect(text).toMatch(/omitted\]|more files? not shown\]/);
  });

  it('closes a fence it had to cut short', () => {
    const text = render({ includeDiffs: true }, 1600);
    // An unterminated fence would make everything after the diff read as code.
    expect([...text.matchAll(/```/g)].length % 2).toBe(0);
  });

  it('holds to the ceiling at every size, and marks every cut', () => {
    for (const maxBytes of [300, 600, 1200, 2400, 5000]) {
      const text = render({ includeDiffs: true }, maxBytes);
      expect(byteLength(text), `budget ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      if (!text.includes('Name the refill constant')) {
        expect(text, `budget ${maxBytes}`).toMatch(/not shown|omitted/);
      }
    }
  });

  it('says what a diffless view is missing, and which of it is not stored', () => {
    const text = render();

    expect(text).not.toContain('```diff');
    expect(text).toContain('[diff not shown: 3 files +133 -4, 1 file with no stored hunk');
  });

  it('quotes no diff size it cannot measure', () => {
    // A store synced with `includePatches: false` holds file summaries and no
    // hunks, which is indistinguishable here from hunks it does hold. The old
    // estimate read the line counts and advertised ~392 KB for a `--diff` that
    // emits twenty "[no diff hunk recorded]" lines.
    fixture.addThread({
      number: 500,
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      files: Array.from({ length: 20 }, (_, index) => ({
        path: `src/module${index}.ts`,
        additions: 400,
        deletions: 100,
        patch: null,
      })),
    });
    const view = (options: ThreadViewOptions) =>
      queryThread(fixture.store, resolveThreadRef(fixture.store, 'platform/acme/api#500'), options);

    const text = renderThread(view({}), { now: NOW });
    expect(text).toContain('[diff not shown: 20 files +8000 -2000 — pass --diff');
    // No number at all beats one 400× out: this view has no evidence for one.
    expect(text).not.toMatch(/~[\d.]+ [KM]?B/);

    const expanded = renderThread(view({ includeDiffs: true }), { now: NOW });
    expect(expanded).toContain('[no diff hunk recorded]');
  });

  it('says plainly when the store holds no hunks at all', () => {
    fixture.addThread({
      number: 501,
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      files: [
        { path: 'package-lock.json', additions: 9000, deletions: 900, patch: null, patchTruncated: true },
        { path: 'dist/bundle.js', additions: 4000, deletions: 40, patch: null, patchTruncated: true },
      ],
    });

    const text = renderThread(
      queryThread(fixture.store, resolveThreadRef(fixture.store, 'platform/acme/api#501'), {}),
      { now: NOW },
    );

    expect(text).toContain(
      '[diff not shown: 2 files +13000 -940 — no hunks stored, --diff would add file headers only]',
    );
  });

  it('closes a fence in a comment it had to cut', () => {
    // A ```suggestion block is routine on a review comment. Cut mid-fence, the
    // notice saying the comment was cut — and the whole footer under it — would
    // render as code.
    fixture.addThread({
      number: 502,
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      body: null,
      events: [
        {
          at: '2026-07-22T08:00:00Z',
          by: KAI,
          body: `Take the constant out:\n\n\`\`\`suggestion\n${'const REFILL_PER_SECOND = 10;\n'.repeat(100)}\`\`\`\n\nOtherwise this reads fine.`,
        },
      ],
    });

    for (const maxBytes of [400, 700, 1000, 1600, 2600, 4000]) {
      const text = renderThread(
        queryThread(fixture.store, resolveThreadRef(fixture.store, 'platform/acme/api#502'), {}),
        { now: NOW, maxBytes },
      );

      expect(byteLength(text), `budget ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      expect([...text.matchAll(/^```/gm)].length % 2, `budget ${maxBytes}`).toBe(0);
      // The notice, and everything the footer adds after it, sits outside the
      // fence rather than inside it.
      const notice = text.indexOf('… [');
      if (notice >= 0) {
        expect(text.lastIndexOf('```'), `budget ${maxBytes}`).toBeLessThan(notice);
      }
    }
  });

  it('closes a fence the comment itself left open', () => {
    fixture.addThread({
      number: 503,
      createdAt: '2026-07-01T00:00:00Z',
      author: ADA,
      body: null,
      events: [{ at: '2026-07-22T08:00:00Z', by: KAI, body: 'Repro:\n\n```sh\nchyme sync' }],
    });

    const text = renderThread(
      queryThread(fixture.store, resolveThreadRef(fixture.store, 'platform/acme/api#503'), {}),
      { now: NOW },
    );

    // Nothing was cut, but an author's own unterminated fence would swallow the
    // footer just as thoroughly as one of ours.
    expect(text).toContain('chyme sync');
    expect([...text.matchAll(/^```/gm)].length % 2).toBe(0);
  });

  it('names events its options withheld', () => {
    expect(render({ includeCommits: false })).toContain('[1 commit withheld by the options given]');
  });

  it('prints the reference graph both ways', () => {
    const other = fixture.addThread({ number: 88, createdAt: '2026-06-01T00:00:00Z' });
    const thread = resolveThreadRef(fixture.store, 'platform/acme/api#412').thread;

    const [out] = fixture.store.references.replaceReferences({ kind: 'thread', id: thread.id }, [
      { refKind: 'thread', refRaw: '#88', hint: null },
      { refKind: 'ticket', refRaw: 'PROJ-12', hint: null },
    ]);
    fixture.store.references.resolveReference(out!.id, { kind: 'thread', id: other.id }, 1);

    const [incoming] = fixture.store.references.replaceReferences(
      { kind: 'thread', id: other.id },
      [{ refKind: 'thread', refRaw: '#412', hint: null }],
    );
    fixture.store.references.resolveReference(incoming!.id, { kind: 'thread', id: thread.id }, 1);

    const text = render();
    expect(text).toContain('refs out: #88 → platform/acme/api#88 · PROJ-12 (ticket, unresolved)');
    expect(text).toContain('refs in: platform/acme/api#88');
  });
});
