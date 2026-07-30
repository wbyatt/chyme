import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolveThreadRef } from '../../query/refs.js';
import { queryThread } from '../../query/thread.js';
import { renderThread } from '../../render/thread.js';
import { openStoreFor, optionalProject } from '../context.js';
import { parseByteBudget } from '../options.js';
import { emit, runCommand } from '../output.js';

interface ThreadOptions {
  project?: string;
  diff?: boolean;
  comments: boolean;
  commits: boolean;
  maxBytes?: string;
}

export function registerThreadCommand(program: Command): void {
  program
    .command('thread')
    .argument('<ref>', 'thread reference, e.g. platform/acme/api#412, or just #412')
    .description('Expand one thread in full')
    .option('-p, --project <slug>', 'project to resolve the reference in')
    .option('-d, --diff', 'include diff hunks')
    .option('--no-comments', 'omit comments and reviews')
    .option('--no-commits', 'omit commit messages')
    .option('--max-bytes <n>', 'byte budget for the output')
    .action((ref: string, options: ThreadOptions) =>
      runCommand(() => {
        const { config } = loadConfig();
        const store = openStoreFor(config);

        try {
          // The project is only needed to disambiguate a partial reference, so a
          // fully-qualified ref works even when several projects are configured.
          const projectSlug = optionalProject(config, options.project)?.slug;

          const target = resolveThreadRef(store, ref, projectSlug ? { projectSlug } : {});
          const view = queryThread(store, target, {
            includeComments: options.comments,
            includeCommits: options.commits,
            includeDiffs: options.diff ?? false,
          });

          const maxBytes = parseByteBudget(options.maxBytes);
          emit(renderThread(view, maxBytes === undefined ? {} : { maxBytes }));
        } finally {
          store.close();
        }
      }),
    );
}
