import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolveWindow } from '../../query/window.js';
import { renderDigest, renderDigestList } from '../../render/digest.js';
import { ChymeError, NotFoundError } from '../../util/errors.js';
import { toIso, type TimeSpec } from '../../util/time.js';
import { openStoreFor, requireSyncedProject, selectProject } from '../context.js';
import {
  parseByteBudget,
  parsePositiveInt,
  parseSince,
  parseUntil,
  parseWindowArgument,
} from '../options.js';
import { emit, note, runCommand } from '../output.js';

/** Read the digest body from a file, or from stdin when given `-` or nothing. */
function readBody(file: string | undefined): string {
  const source = file ?? '-';
  if (source === '-' && process.stdin.isTTY) {
    // Reading a terminal here blocks until the user works out that they are
    // being asked for input and presses Ctrl-D, with nothing on screen to say
    // so. A digest is composed elsewhere and piped in; a terminal on stdin
    // means the pipe was forgotten.
    throw new ChymeError(
      'Nothing was piped in, so there is no digest to save.',
      'Pipe the composed digest in: chyme digest save --since 7d < digest.md — or pass --file <path>.',
    );
  }
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

/**
 * The window the digest covers.
 *
 * `--window` is both ends at once, in the form `chyme activity` prints, so the
 * window that was read is the window that gets stored. `--since`/`--until` is
 * the hand-written form and re-resolves an absent end to now. They describe the
 * same thing, so mixing them is refused rather than ranked.
 */
function windowArgument(
  options: { since?: string; until?: string; window?: string },
  now: Date,
): { since: TimeSpec; until: TimeSpec | undefined } {
  if (options.window !== undefined) {
    if (options.since !== undefined || options.until !== undefined) {
      throw new ChymeError(
        'Pass either --window or --since/--until, not both.',
        'They set the same two instants; --window is the pair `chyme activity` printed.',
      );
    }
    return parseWindowArgument(options.window, now);
  }

  if (options.since === undefined) {
    throw new ChymeError(
      'digest save needs the window this digest covers.',
      'Pass --window with the line `chyme activity` printed, or --since <when>.',
    );
  }

  return { since: parseSince(options.since, now), until: parseUntil(options.until, now) };
}

export function registerDigestCommands(program: Command): void {
  const digest = program
    .command('digest')
    .description('Save and re-read composed digests');

  digest
    .command('save')
    .description('Store a composed digest and the window it covers')
    .option('-p, --project <slug>')
    .option('-s, --since <when>', 'start of the window this digest covers')
    .option('-u, --until <when>', 'end of the window; defaults to now')
    .option(
      '-w, --window <since..until>',
      'the whole window, as `chyme activity` printed it — saves exactly what was read',
    )
    .option('-f, --file <path>', 'read the digest body from a file instead of stdin')
    .action(
      (options: {
        project?: string;
        since?: string;
        until?: string;
        window?: string;
        file?: string;
      }) =>
        runCommand(() => {
          const { config } = loadConfig();
          const projectConfig = selectProject(config, options.project);
          const store = openStoreFor(config);

          try {
            const project = requireSyncedProject(store, projectConfig);
            const now = new Date();
            const asked = windowArgument(options, now);
            const window = resolveWindow(store, project.id, {
              since: asked.since,
              ...(asked.until ? { until: asked.until } : {}),
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
                params: options.window
                  ? { window: options.window }
                  : { since: options.since, until: options.until ?? null },
                bodyMd,
              },
              toIso(now),
            );

            note(
              `Saved digest ${saved.id} covering ${saved.windowStart} to ${saved.windowEnd}.`,
            );
            note('`--since last` now resolves to the end of this window.');
            if (window.untilOrigin === 'now') {
              // Said out loud because the cost is invisible: the end is the
              // moment of saving, not the moment the material was read, and
              // nothing that moved in between will be enumerated again.
              note(
                'That window ends now, not where the reading stopped — pass the `window:` line `chyme activity` printed as --window to save exactly what was read.',
              );
            }
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
          const digests = store.digests.listDigests(project.id, limit);
          // The page cannot report on what the LIMIT removed, so the count comes
          // separately: a listing that says "20 saved" over the first 20 of 50
          // is not short, it is wrong.
          const total = store.digests.countDigests(project.id);
          const maxBytes = parseByteBudget(options.maxBytes);
          emit(
            renderDigestList(project, digests, {
              now: new Date(),
              total,
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
