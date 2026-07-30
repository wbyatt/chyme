import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { queryActivity } from '../../query/activity.js';
import { resolveWindow } from '../../query/window.js';
import { renderActivity } from '../../render/activity.js';
import { openStoreFor, requireSyncedProject, selectProject } from '../context.js';
import {
  formatWindowArgument,
  parseByteBudget,
  parseSince,
  parseThreadKinds,
  parseUntil,
  splitList,
} from '../options.js';
import { emit, note, runCommand } from '../output.js';

interface ActivityOptions {
  project?: string;
  since: string;
  until?: string;
  author?: string;
  repo?: string;
  path?: string;
  kind?: string;
  includeBots?: boolean;
  maxBytes?: string;
}

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('What moved in a window: a compact index, one block per thread')
    .option('-p, --project <slug>')
    .option(
      '-s, --since <when>',
      'last (end of the most recent saved digest), a relative offset like 7d, a date, or an ISO timestamp',
      '7d',
    )
    .option('-u, --until <when>', 'upper bound; defaults to now')
    .option('-a, --author <handles>', 'comma-separated handles')
    .option('-r, --repo <keys>', 'comma-separated source keys, e.g. acme/api')
    .option('--path <prefixes>', 'comma-separated path prefixes')
    .option('-k, --kind <kinds>', 'comma-separated: pull_request,issue,discussion')
    .option('--include-bots', 'let bot activity pull a thread into the result')
    .option('--max-bytes <n>', 'byte budget for the output')
    .action((options: ActivityOptions) =>
      runCommand(() => {
        const { config } = loadConfig();
        const projectConfig = selectProject(config, options.project);
        const store = openStoreFor(config);

        try {
          const project = requireSyncedProject(store, projectConfig);
          const now = new Date();

          const until = parseUntil(options.until, now);
          const window = resolveWindow(store, project.id, {
            since: parseSince(options.since, now),
            ...(until ? { until } : {}),
            now,
          });

          const authors = splitList(options.author);
          const sourceKeys = splitList(options.repo);
          const paths = splitList(options.path);
          const kinds = parseThreadKinds(options.kind);

          const result = queryActivity(store, project, window, {
            ...(authors ? { authors } : {}),
            ...(sourceKeys ? { sourceKeys } : {}),
            ...(paths ? { paths } : {}),
            ...(kinds ? { kinds } : {}),
            includeBots: options.includeBots ?? false,
          });

          const maxBytes = parseByteBudget(options.maxBytes);
          emit(renderActivity(result, { now, ...(maxBytes === undefined ? {} : { maxBytes }) }));

          // The window this run actually read, in the form `digest save
          // --window` takes. Composing a digest takes minutes, and a save that
          // re-resolves its own `--until` to "now" ends the stored window after
          // the reading stopped — so whatever moved in between is enumerated by
          // no digest, and `--since last` steps straight over it.
          note(`window: ${formatWindowArgument(window.since, window.until)}`);
        } finally {
          store.close();
        }
      }),
    );
}
