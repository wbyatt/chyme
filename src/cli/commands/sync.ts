import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolveInstant } from '../../query/window.js';
import { renderSyncReport } from '../../render/sync.js';
import { syncFailed, syncProject, type SyncProgress } from '../../sync/sync.js';
import { driverResolver, openStoreFor, selectProject } from '../context.js';
import { emit, note, runCommand } from '../output.js';
import { parseByteBudget, parseSince } from '../options.js';

interface SyncCommandOptions {
  project?: string;
  full?: boolean;
  since?: string;
  quiet?: boolean;
  maxBytes?: string;
}

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

/**
 * Ctrl-C: abort the in-flight request rather than killing the process
 * mid-thread, so everything already committed keeps its watermark.
 *
 * The escalation is not a nicety. Installing any SIGINT listener takes Node's
 * default terminate-on-Ctrl-C away, and `abort()` is idempotent — so without
 * it, a user whose second and third Ctrl-C did nothing at all is left with a
 * process they cannot stop while a slow request runs its course.
 */
export function createInterruptHandler(
  controller: AbortController,
  quit: (code: number) => void,
): () => void {
  let signals = 0;
  return () => {
    signals += 1;
    if (signals === 1) {
      note('interrupted; finishing the current thread…');
      controller.abort();
      return;
    }
    // 128 + SIGINT, the shell's convention for "killed by Ctrl-C".
    note('interrupted again; stopping now. The current thread was not saved.');
    quit(130);
  };
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description("Pull everything new or changed from a project's sources")
    .option('-p, --project <slug>', 'project to sync')
    .option('--full', 'ignore stored watermarks and re-read every thread')
    .option(
      '-s, --since <when>',
      'read from this instant instead of the stored watermark, to reach back past a first sync or retry a skipped thread',
    )
    .option('-q, --quiet', 'suppress per-thread progress')
    .option('--max-bytes <n>', 'byte budget for the report')
    .action((options: SyncCommandOptions) =>
      runCommand(async () => {
        const { config } = loadConfig();
        const project = selectProject(config, options.project);

        if (project.sources.length === 0) {
          throw new Error(
            `"${project.slug}" has no sources to sync. Add one with: chyme source add <owner/repo> --project ${project.slug}`,
          );
        }

        const store = openStoreFor(config);
        const controller = new AbortController();
        const interrupt = createInterruptHandler(controller, (code) => process.exit(code));

        try {
          // Installed only once there is something to interrupt, and removed in
          // the finally below. Any SIGINT listener disarms Node's default
          // terminate-on-Ctrl-C, so one left behind by a throw on the way in
          // disarms it for whatever runs next.
          process.on('SIGINT', interrupt);

          const now = new Date();
          // `last` is meaningful here too — "resync everything since the digest
          // I last saved" — and it can only resolve against a stored project.
          const since =
            options.since === undefined
              ? undefined
              : resolveInstant(
                  store,
                  store.projects.findProject(project.slug)?.id ?? 0,
                  parseSince(options.since, now),
                ).at;

          const report = await syncProject(
            store,
            project,
            driverResolver(config),
            config.sync,
            {
              full: options.full ?? false,
              signal: controller.signal,
              ...(since === undefined ? {} : { since }),
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
