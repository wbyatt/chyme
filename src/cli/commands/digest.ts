import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolveWindow } from '../../query/window.js';
import { renderDigest, renderDigestList } from '../../render/digest.js';
import { ChymeError, NotFoundError } from '../../util/errors.js';
import { toIso } from '../../util/time.js';
import { openStoreFor, requireSyncedProject, selectProject } from '../context.js';
import { parseByteBudget, parsePositiveInt, parseSince, parseUntil } from '../options.js';
import { emit, note, runCommand } from '../output.js';

/** Read the digest body from a file, or from stdin when given `-` or nothing. */
function readBody(file: string | undefined): string {
  const source = file ?? '-';
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  if (text.trim().length === 0) {
    throw new ChymeError(
      'Refusing to save an empty digest.',
      source === '-'
        ? 'Pipe the composed digest in, or pass --file <path>.'
        : `${source} is empty.`,
    );
  }
  return text;
}

export function registerDigestCommands(program: Command): void {
  const digest = program
    .command('digest')
    .description('Save and re-read composed digests');

  digest
    .command('save')
    .description('Store a composed digest and the window it covers')
    .option('-p, --project <slug>')
    .requiredOption('-s, --since <when>', 'start of the window this digest covers')
    .option('-u, --until <when>', 'end of the window; defaults to now')
    .option('-f, --file <path>', 'read the digest body from a file instead of stdin')
    .action(
      (options: { project?: string; since: string; until?: string; file?: string }) =>
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

            // Read the body only after the window resolves, so a bad --since
            // does not consume a pipe the caller cannot rewind.
            const bodyMd = readBody(options.file);

            const saved = store.digests.insertDigest(
              {
                projectId: project.id,
                windowStart: window.since,
                windowEnd: window.until,
                params: { since: options.since, until: options.until ?? null },
                bodyMd,
              },
              toIso(now),
            );

            note(
              `Saved digest ${saved.id} covering ${saved.windowStart} to ${saved.windowEnd}.`,
            );
            note('`--since last` now resolves to the end of this window.');
            emit(String(saved.id));
          } finally {
            store.close();
          }
        }),
    );

  digest
    .command('list')
    .description('List saved digests, most recent first')
    .option('-p, --project <slug>')
    .option('-n, --limit <n>', 'how many to list')
    .option('--max-bytes <n>')
    .action((options: { project?: string; limit?: string; maxBytes?: string }) =>
      runCommand(() => {
        const { config } = loadConfig();
        const projectConfig = selectProject(config, options.project);
        const store = openStoreFor(config);

        try {
          const project = requireSyncedProject(store, projectConfig);
          const limit = parsePositiveInt(options.limit, '--limit');
          const digests = store.digests.listDigests(project.id, limit ?? 20);
          const maxBytes = parseByteBudget(options.maxBytes);
          emit(
            renderDigestList(project, digests, {
              now: new Date(),
              ...(maxBytes === undefined ? {} : { maxBytes }),
            }),
          );
        } finally {
          store.close();
        }
      }),
    );

  digest
    .command('show')
    .argument('<id>', 'digest id from `chyme digest list`')
    .description('Print a saved digest')
    .option('--max-bytes <n>')
    .action((id: string, options: { maxBytes?: string }) =>
      runCommand(() => {
        const { config } = loadConfig();
        const store = openStoreFor(config);

        try {
          const digestId = parsePositiveInt(id, 'digest id');
          const row = digestId === undefined ? null : store.digests.getDigest(digestId);
          if (!row) {
            throw new NotFoundError(
              `No digest ${id}.`,
              'List them with: chyme digest list',
            );
          }

          const project = store.projects.getProject(row.projectId);
          if (!project) {
            throw new NotFoundError(`Digest ${id} belongs to a project that no longer exists.`);
          }

          const maxBytes = parseByteBudget(options.maxBytes);
          emit(
            renderDigest(project, row, {
              now: new Date(),
              ...(maxBytes === undefined ? {} : { maxBytes }),
            }),
          );
        } finally {
          store.close();
        }
      }),
    );
}
