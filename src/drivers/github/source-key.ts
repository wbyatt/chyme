import { ConfigError } from '../../util/errors.js';

/**
 * Turning whatever a user pasted into the `owner/repo` the rest of the driver
 * works in. Kept apart from driver.ts because it is pure, gets the most test
 * pressure of anything here, and is the single definition of what a GitHub
 * source key is allowed to look like.
 */

/** GitHub logins: alphanumeric with single interior hyphens. */
const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;
/** Repository names are laxer: dots, underscores and hyphens all appear. */
const REPO = /^[A-Za-z0-9_.-]+$/;

const HOSTS = new Set(['github.com', 'www.github.com']);

const HINT =
  'Give a repository as owner/repo (e.g. anthropics/claude-code), or paste its GitHub URL.';

export interface GitHubRepo {
  owner: string;
  name: string;
}

function reject(input: string, why: string): never {
  throw new ConfigError(`"${input}" is not a GitHub repository: ${why}`, HINT);
}

/**
 * Owner and repo are lower-cased. GitHub treats them case-insensitively, so
 * `Owner/Repo` and `owner/repo` are one source; if the key kept its casing they
 * would become two rows in the store pointing at the same repository.
 */
function normalize(input: string, owner: string, name: string): string {
  const repo = name.replace(/\.git$/i, '');
  if (!OWNER.test(owner)) reject(input, `"${owner}" is not a valid owner name`);
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    reject(input, `"${repo}" is not a valid repository name`);
  }
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function fromUrl(input: string, url: URL): string {
  if (url.hostname !== '' && !HOSTS.has(url.hostname.toLowerCase())) {
    throw new ConfigError(
      `"${input}" points at ${url.hostname}, which this driver cannot reach.`,
      'Only github.com is supported. GitHub Enterprise Server would need its own configured base URL.',
    );
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const owner = segments[0];
  const name = segments[1];
  if (owner === undefined || name === undefined) {
    reject(input, 'the URL has no owner/repo path');
  }
  // Deeper paths are fine and common — people paste the URL of the pull request
  // they are looking at. Everything past the repository is simply dropped.
  return normalize(input, owner, name);
}

export function parseSourceKey(input: string): string {
  const value = input.trim();
  if (value === '') {
    throw new ConfigError('Empty GitHub source key.', HINT);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      reject(value, 'it is not a readable URL');
    }
    return fromUrl(value, url);
  }

  // scp-style remotes, because `git remote -v` prints them and people paste it.
  const ssh = /^(?:ssh:\/\/)?git@([^:]+):(.+)$/.exec(value);
  if (ssh) {
    const host = ssh[1]!;
    if (!HOSTS.has(host.toLowerCase())) {
      throw new ConfigError(
        `"${value}" points at ${host}, which this driver cannot reach.`,
        'Only github.com is supported.',
      );
    }
    const parts = ssh[2]!.split('/').filter((part) => part !== '');
    const owner = parts[0];
    const name = parts[1];
    if (owner === undefined || name === undefined || parts.length > 2) {
      reject(value, 'the remote has no owner/repo path');
    }
    return normalize(value, owner, name);
  }

  const parts = value.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) {
    reject(value, 'expected exactly one "/" separating owner from repository');
  }
  return normalize(value, parts[0]!, parts[1]!);
}

/**
 * Split a key that has already been through parseSourceKey. Stored keys come
 * back from the database months later, so this re-validates rather than
 * trusting; a corrupt key should fail here and not as a confusing 404.
 */
export function splitSourceKey(key: string): GitHubRepo {
  const normalized = parseSourceKey(key);
  const [owner, name] = normalized.split('/');
  return { owner: owner!, name: name! };
}

export function describeSource(key: string): string {
  return `github.com/${key}`;
}
