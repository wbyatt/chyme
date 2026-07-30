import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { renderSyncReport } from '../../render/sync.js';
import { syncFailed, syncProject, type SyncProgress } from '../../sync/sync.js';
import { driverResolver, openStoreFor, selectProject } from '../context.js';
import { emit, note, runCommand } from '../output.js';
import { parseByteBudget } from '../options.js';

function progressLine(event: SyncProgress): string | null {
  switch (event.kind) {
    case 'source-start':
      return `${event.driver}:${event.key} …`;
    case 'thread':
      // Unchanged threads are the common case on a warm store and saying so for
      // each of them buries the ones that actually moved.
      return event.outcome === 'written'
        ? `  ${event.threadKind === 'pull_request' ? 'pr' : event.threadKind} #${event.number} ${event.title}`
        : null;
    case 'source-done':
      return event.error ? `${event.driver}:${event.key} failed: ${event.error}` : null;
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description("Pull everything new or changed from a project's sources")
    .option('-p, --project <slug>', 'project to sync')
    .option('--full', 'ignore stored watermarks and re-read every thread')
    .option('-q, --quiet', 'suppress per-thread progress')
    .option('--max-bytes <n>', 'byte budget for the report')
    .action((options: { project?: string; full?: boolean; quiet?: boolean; maxBytes?: string }) =>
      runCommand(async () => {
        const { config } = loadConfig();
        const project = selectProject(config, options.project);

        if (project.sources.length === 0) {
          throw new Error(
            `"${project.slug}" has no sources to sync. Add one with: chyme source add <owner/repo> --project ${project.slug}`,
          );
        }

        // Ctrl-C aborts the in-flight request rather than killing the process
        // mid-thread; everything already committed keeps its watermark.
        const controller = new AbortController();
        const interrupt = (): void => {
          note('interrupted; finishing the current thread…');
          controller.abort();
        };
        process.on('SIGINT', interrupt);

        const store = openStoreFor(config);
        try {
          const report = await syncProject(
            store,
            project,
            driverResolver(config),
            config.sync,
            {
              full: options.full ?? false,
              signal: controller.signal,
              ...(options.quiet
                ? {}
                : {
                    onProgress: (event: SyncProgress) => {
                      const line = progressLine(event);
                      if (line) note(line);
                    },
                  }),
            },
          );

          const maxBytes = parseByteBudget(options.maxBytes);
          emit(renderSyncReport(report, maxBytes === undefined ? {} : { maxBytes }));

          if (syncFailed(report)) process.exitCode = 1;
        } finally {
          process.off('SIGINT', interrupt);
          store.close();
        }
      }),
    );
}
