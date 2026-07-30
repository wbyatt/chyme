import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { querySearch } from '../../query/search.js';
import { resolveInstant } from '../../query/window.js';
import { renderSearch } from '../../render/search.js';
import { openStoreFor, requireSyncedProject, selectProject } from '../context.js';
import { parseByteBudget, parsePositiveInt, parseSince, parseUntil } from '../options.js';
import { emit, runCommand } from '../output.js';

interface SearchOptions {
  project?: string;
  since?: string;
  until?: string;
  limit?: string;
  maxBytes?: string;
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .argument('<query...>', 'words to search for; quote a phrase to require it')
    .description('Keyword search across synced titles, descriptions and discussion')
    .option('-p, --project <slug>', 'scope to one project')
    .option('-s, --since <when>')
    .option('-u, --until <when>')
    .option('-n, --limit <n>', 'maximum hits')
    .option('--max-bytes <n>', 'byte budget for the output')
    .action((words: string[], options: SearchOptions) =>
      runCommand(() => {
        const { config } = loadConfig();
        const store = openStoreFor(config);

        try {
          const now = new Date();

          // Searching every project is meaningful, so a project is resolved only
          // when one was asked for or exactly one is configured.
          let project = undefined;
          try {
            project = requireSyncedProject(store, selectProject(config, options.project));
          } catch (error) {
            if (options.project) throw error;
          }

          const since = options.since
            ? resolveInstant(store, project?.id ?? 0, parseSince(options.since, now)).at
            : undefined;
          const untilSpec = parseUntil(options.until, now);
          const until = untilSpec
            ? resolveInstant(store, project?.id ?? 0, untilSpec).at
            : undefined;

          const limit = parsePositiveInt(options.limit, '--limit');

          const results = querySearch(store, {
            text: words.join(' '),
            ...(project ? { project } : {}),
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            ...(limit === undefined ? {} : { limit }),
          });

          const maxBytes = parseByteBudget(options.maxBytes);
          emit(renderSearch(results, { now, ...(maxBytes === undefined ? {} : { maxBytes }) }));
        } finally {
          store.close();
        }
      }),
    );
}
