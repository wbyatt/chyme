import { z } from 'zod';
import { ConfigError } from '../../util/errors.js';
import type { DriverFactory, SourceDriver } from '../types.js';
import { GitHubClient } from './client.js';
import { GitHubDriver } from './driver.js';
import { parseSourceKey } from './source-key.js';

/**
 * The only door into this directory.
 *
 * Everything else under `github/` — queries, payload shapes, rate-limit
 * headers, the word "GraphQL" — stays behind the SourceDriver interface. What
 * leaves is a factory and a driver id, which is exactly as much as the rest of
 * Chyme is allowed to know about GitHub.
 */

const credentialsSchema = z.object({
  token: z.string().min(1, 'must not be empty'),
});

const HINT =
  'Add it to the Chyme config as credentials.github.token. String values there support ${GITHUB_TOKEN} interpolation, so you can point at an environment variable rather than writing a token to disk. A classic token needs `repo` scope for private repositories; `public_repo` is enough for public ones.';

export const githubDriverFactory: DriverFactory = {
  id: 'github',

  // Discussions are deliberately absent: the driver raises NotImplementedError
  // for them, and listing them here would trade a clear config-time rejection
  // for a failure partway through a sync.
  supportedKinds: ['pull_request', 'issue'],

  parseSourceKey,

  create(credentials: Record<string, unknown> | undefined): SourceDriver {
    if (credentials === undefined) {
      throw new ConfigError('No GitHub credentials are configured.', HINT);
    }

    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `credentials.github.${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ConfigError(`GitHub credentials are invalid: ${issues}`, HINT);
    }

    return new GitHubDriver(new GitHubClient({ token: parsed.data.token }));
  },
};
