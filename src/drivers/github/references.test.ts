import { describe, expect, it } from 'vitest';
import { extractReferences } from './references.js';

describe('extractReferences', () => {
  it('finds a bare thread reference, and records only what it knows', () => {
    expect(extractReferences('Fixes #123.')).toEqual([
      { refKind: 'thread', refRaw: '#123', hint: { number: 123 } },
    ]);
  });

  it('finds a cross-repository thread reference', () => {
    expect(extractReferences('See anthropics/claude-code#45 for context')).toEqual([
      {
        refKind: 'thread',
        refRaw: 'anthropics/claude-code#45',
        hint: { owner: 'anthropics', repo: 'claude-code', number: 45 },
      },
    ]);
  });

  it('reads a pull request URL, including which kind of thread it is', () => {
    expect(extractReferences('cf https://github.com/o/r/pull/9')).toEqual([
      {
        refKind: 'thread',
        refRaw: 'https://github.com/o/r/pull/9',
        hint: { owner: 'o', repo: 'r', kind: 'pull_request', number: 9 },
      },
    ]);
  });

  it('reads issue and discussion URLs', () => {
    expect(extractReferences('https://github.com/o/r/issues/9')[0]?.hint).toMatchObject({
      kind: 'issue',
      number: 9,
    });
    expect(extractReferences('https://github.com/o/r/discussions/4')[0]?.hint).toMatchObject({
      kind: 'discussion',
      number: 4,
    });
  });

  it('reads a commit URL', () => {
    expect(extractReferences('reverted in https://github.com/o/r/commit/a1b2c3d4e5f6')).toEqual([
      {
        refKind: 'commit',
        refRaw: 'https://github.com/o/r/commit/a1b2c3d4e5f6',
        hint: { owner: 'o', repo: 'r', sha: 'a1b2c3d4e5f6' },
      },
    ]);
  });

  it('records other GitHub links as plain urls', () => {
    const [reference] = extractReferences('see https://github.com/o/r/blob/main/README.md');
    expect(reference?.refKind).toBe('url');
    expect(reference?.hint).toMatchObject({ owner: 'o', repo: 'r' });
  });

  it('leaves other forges and the wider web alone', () => {
    expect(extractReferences('https://example.com/rfc/7 and https://gitlab.com/o/r/-/issues/3')).toEqual(
      [],
    );
  });

  it('drops trailing sentence punctuation from a URL', () => {
    expect(extractReferences('(see https://github.com/o/r/pull/9).')[0]?.refRaw).toBe(
      'https://github.com/o/r/pull/9',
    );
  });

  describe('shas', () => {
    it('finds an abbreviated sha', () => {
      expect(extractReferences('broken by deadbeef')).toEqual([
        { refKind: 'commit', refRaw: 'deadbeef', hint: { sha: 'deadbeef' } },
      ]);
    });

    it('finds a full sha', () => {
      const sha = 'a'.repeat(40);
      expect(extractReferences(`at ${sha}`)[0]?.refRaw).toBe(sha);
    });

    it('ignores all-digit runs, which are numbers not shas', () => {
      expect(extractReferences('build 1234567 of 20260729')).toEqual([]);
    });

    it('ignores hex glued into a longer token', () => {
      expect(extractReferences('x_deadbeef_y and deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0')).toEqual(
        [],
      );
    });
  });

  describe('guards', () => {
    it('ignores anything inside a fenced code block', () => {
      const text = ['before', '```c', '#include <x.h>', '#123', 'deadbeef', '```', 'after'].join(
        '\n',
      );
      expect(extractReferences(text)).toEqual([]);
    });

    it('ignores tilde fences too', () => {
      expect(extractReferences('~~~\n#42\n~~~')).toEqual([]);
    });

    it('ignores an inline code span', () => {
      expect(extractReferences('the literal `#42` is not a reference')).toEqual([]);
    });

    it('still reads references outside a fence', () => {
      const text = ['Fixes #7.', '```', '#999', '```', 'Also #8.'].join('\n');
      expect(extractReferences(text).map((reference) => reference.refRaw)).toEqual(['#7', '#8']);
    });

    it('ignores a URL fragment that merely looks like a thread reference', () => {
      expect(extractReferences('see https://docs.example.com/guide.html#123')).toEqual([]);
    });

    it('ignores an HTML numeric entity', () => {
      expect(extractReferences('&#123; is a brace')).toEqual([]);
    });

    it('ignores a hash glued to the end of a word', () => {
      expect(extractReferences('v1#2 is not a reference')).toEqual([]);
    });

    it('does not re-read the number out of a URL it already understood', () => {
      expect(extractReferences('https://github.com/o/r/pull/9')).toHaveLength(1);
    });

    it('ignores a hex colour', () => {
      expect(extractReferences('background #a1b2c3d4 please')).toEqual([]);
    });
  });

  it('records one edge per distinct reference', () => {
    expect(extractReferences('#1 relates to #1 and to #2')).toEqual([
      { refKind: 'thread', refRaw: '#1', hint: { number: 1 } },
      { refKind: 'thread', refRaw: '#2', hint: { number: 2 } },
    ]);
  });

  it('returns references in the order a reader meets them', () => {
    const text = 'First #1, then deadbeef, then https://github.com/o/r/issues/3.';
    expect(extractReferences(text).map((reference) => reference.refRaw)).toEqual([
      '#1',
      'deadbeef',
      'https://github.com/o/r/issues/3',
    ]);
  });

  it('handles empty and reference-free text', () => {
    expect(extractReferences('')).toEqual([]);
    expect(extractReferences('Nothing to see here.')).toEqual([]);
  });
});
