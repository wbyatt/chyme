import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../util/errors.js';
import { describeSource, parseSourceKey, splitSourceKey } from './source-key.js';

describe('parseSourceKey', () => {
  it('passes through a plain owner/repo', () => {
    expect(parseSourceKey('anthropics/claude-code')).toBe('anthropics/claude-code');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSourceKey('  owner/repo \n')).toBe('owner/repo');
  });

  it('lower-cases, so one repository cannot become two sources', () => {
    expect(parseSourceKey('Owner/Repo')).toBe('owner/repo');
    expect(parseSourceKey('OWNER/REPO')).toBe(parseSourceKey('owner/repo'));
  });

  it('drops a .git suffix', () => {
    expect(parseSourceKey('owner/repo.git')).toBe('owner/repo');
  });

  it('accepts repository names with dots, underscores and hyphens', () => {
    expect(parseSourceKey('owner/my_repo.v2-beta')).toBe('owner/my_repo.v2-beta');
  });

  describe('URLs', () => {
    it('reduces a repository URL', () => {
      expect(parseSourceKey('https://github.com/Owner/Repo')).toBe('owner/repo');
    });

    it('reduces a deep URL to the repository that contains it', () => {
      expect(parseSourceKey('https://github.com/owner/repo/pull/1234')).toBe('owner/repo');
      expect(parseSourceKey('https://github.com/owner/repo/blob/main/src/index.ts')).toBe(
        'owner/repo',
      );
    });

    it('tolerates www, trailing slashes, and .git', () => {
      expect(parseSourceKey('https://www.github.com/owner/repo/')).toBe('owner/repo');
      expect(parseSourceKey('https://github.com/owner/repo.git')).toBe('owner/repo');
    });

    it('accepts an scp-style git remote, because git remote -v prints one', () => {
      expect(parseSourceKey('git@github.com:owner/repo.git')).toBe('owner/repo');
      expect(parseSourceKey('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
    });
  });

  describe('rejections', () => {
    const bad: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'blank'],
      ['owner', 'no separator'],
      ['owner/repo/extra', 'too many segments'],
      ['/owner', 'no repository'],
      ['ow ner/repo', 'space in the owner'],
      ['-owner/repo', 'owner may not start with a hyphen'],
      ['owner/..', 'path traversal dressed as a repository'],
      ['https://github.com/owner', 'URL with no repository'],
      ['https://gitlab.com/owner/repo', 'another forge'],
      ['git@gitlab.com:owner/repo.git', 'another forge over ssh'],
      ['https://github.example.com/owner/repo', 'GitHub Enterprise Server'],
    ];

    for (const [input, why] of bad) {
      it(`rejects ${JSON.stringify(input)} (${why})`, () => {
        expect(() => parseSourceKey(input)).toThrow(ConfigError);
      });
    }

    it('says what to do instead', () => {
      try {
        parseSourceKey('nope');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).hint).toContain('owner/repo');
      }
    });

    it('names the unreachable host rather than the syntax', () => {
      try {
        parseSourceKey('https://github.example.com/owner/repo');
        expect.unreachable();
      } catch (error) {
        expect((error as ConfigError).message).toContain('github.example.com');
      }
    });
  });
});

describe('splitSourceKey', () => {
  it('splits a stored key', () => {
    expect(splitSourceKey('owner/repo')).toEqual({ owner: 'owner', name: 'repo' });
  });

  it('re-validates, because stored keys are read back months later', () => {
    expect(() => splitSourceKey('not a key')).toThrow(ConfigError);
  });
});

describe('describeSource', () => {
  it('reads as a place a person could go', () => {
    expect(describeSource('owner/repo')).toBe('github.com/owner/repo');
  });
});
