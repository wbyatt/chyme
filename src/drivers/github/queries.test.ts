import { describe, expect, it } from 'vitest';
import * as Q from './queries.js';

/**
 * Structural checks on the documents. A missing fragment or an unbalanced brace
 * is otherwise only discovered by a live request, which is the one thing these
 * tests may not make — and a query that fails at runtime fails the whole sync.
 */

const DOCUMENTS: Array<[string, string]> = Object.entries(Q)
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  .filter(([, value]) => value.includes('query '));

function definedFragments(document: string): Set<string> {
  return new Set([...document.matchAll(/fragment\s+(\w+)\s+on\s+\w+/g)].map((match) => match[1]!));
}

function spreadFragments(document: string): Set<string> {
  // `...on Type` is an inline fragment, not a named spread.
  return new Set(
    [...document.matchAll(/\.\.\.\s*(\w+)/g)]
      .map((match) => match[1]!)
      .filter((name) => name !== 'on'),
  );
}

describe('GraphQL documents', () => {
  it('exports the documents the driver uses', () => {
    expect(DOCUMENTS.map(([name]) => name).sort()).toEqual([
      'ISSUE_COMMENTS_PAGE',
      'ISSUE_DETAIL',
      'LIST_ISSUES',
      'LIST_PULL_REQUESTS',
      'PULL_REQUEST_COMMENTS_PAGE',
      'PULL_REQUEST_COMMITS_PAGE',
      'PULL_REQUEST_DETAIL',
      'PULL_REQUEST_FILES_PAGE',
      'PULL_REQUEST_REVIEWS_PAGE',
      'REVIEW_COMMENTS_PAGE',
    ]);
  });

  for (const [name, document] of DOCUMENTS) {
    describe(name, () => {
      it('defines every fragment it spreads', () => {
        const missing = [...spreadFragments(document)].filter(
          (fragment) => !definedFragments(document).has(fragment),
        );
        expect(missing).toEqual([]);
      });

      it('defines no fragment twice, which GraphQL rejects', () => {
        const names = [...document.matchAll(/fragment\s+(\w+)\s+on\s/g)].map((match) => match[1]!);
        expect(names).toEqual([...new Set(names)]);
      });

      it('spreads every fragment it defines', () => {
        const unused = [...definedFragments(document)].filter(
          (fragment) => !spreadFragments(document).has(fragment),
        );
        expect(unused).toEqual([]);
      });

      it('balances its braces', () => {
        const opened = (document.match(/\{/g) ?? []).length;
        const closed = (document.match(/\}/g) ?? []).length;
        expect(opened).toBe(closed);
      });

      it('declares every variable it uses', () => {
        const declared = new Set(
          [...document.matchAll(/\$(\w+):\s*[\w![\]]+/g)].map((match) => match[1]!),
        );
        const used = new Set([...document.matchAll(/[:\s]\$(\w+)\b/g)].map((match) => match[1]!));
        expect([...used].filter((name) => !declared.has(name))).toEqual([]);
      });
    });
  }

  it('never reaches for the search connection, which caps at 1000 and lags', () => {
    for (const [, document] of DOCUMENTS) {
      expect(document).not.toMatch(/\bsearch\s*\(/);
    }
  });

  it('orders both listings newest-first, which is what the watermark walk assumes', () => {
    for (const document of [Q.LIST_PULL_REQUESTS, Q.LIST_ISSUES]) {
      expect(document).toContain('orderBy: { field: UPDATED_AT, direction: DESC }');
    }
  });

  it('asks for the whole commit message, not just its headline', () => {
    expect(Q.PULL_REQUEST_DETAIL).toMatch(/\bmessage\b/);
  });

  it('does not ask for a diff GraphQL cannot serve', () => {
    // Patch text exists only over REST; selecting it here would be a schema error.
    expect(Q.PULL_REQUEST_DETAIL).not.toMatch(/\bpatch\b/);
  });
});
