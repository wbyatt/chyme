import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../../config/load.js';
import { THREAD_KINDS, type ThreadKind } from '../../domain/types.js';
import { driverIds, findDriverFactory } from '../../drivers/registry.js';
import { ChymeError, NotFoundError } from '../../util/errors.js';
import { selectProject } from '../context.js';
import { emit, note, runCommand } from '../output.js';

/** The config schema requires at least one kind, so the tuple shape is load-bearing. */
type Kinds = [ThreadKind, ...ThreadKind[]];

const DEFAULT_KINDS: Kinds = ['pull_request', 'issue'];

function parseKinds(input: string | undefined): Kinds | null {
  if (input === undefined) return null;

  const kinds = input
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);

  const unknown = kinds.filter((kind) => !THREAD_KINDS.includes(kind as ThreadKind));
  if (unknown.length > 0) {
    throw new ChymeError(
      `Unknown thread ${unknown.length === 1 ? 'kind' : 'kinds'}: ${unknown.join(', ')}`,
      `Known kinds: ${THREAD_KINDS.join(', ')}`,
    );
  }
  const [first, ...rest] = kinds as ThreadKind[];
  if (first === undefined) {
    throw new ChymeError('--kinds needs at least one kind.');
  }
  return [first, ...rest];
}

export function registerSourceCommands(program: Command): void {
  const source = program.command('source').description('Manage the sources feeding a project');

  source
    .command('add')
    .argument('<key>', 'source identifier, e.g. owner/repo or a GitHub URL')
    .option('-p, --project <slug>', 'project to add it to')
    .option('-d, --driver <driver>', 'forge driver', 'github')
    .option('--kinds <kinds>', 'comma-separated: pull_request,issue,discussion')
    .description('Add a source to a project')
    .action((key: string, options: { project?: string; driver: string; kinds?: string }) =>
      runCommand(() => {
        const { config, path } = loadConfig();
        const project = selectProject(config, options.project);

        // Normalizing here rather than at sync time means the config records the
        // canonical key, so `Owner/Repo` and `owner/repo` cannot become two
        // sources pointing at one repository.
        const factory = findDriverFactory(options.driver);
        const normalized = factory.parseSourceKey(key);

        const duplicate = project.sources.find(
          (candidate) => candidate.driver === options.driver && candidate.key === normalized,
        );
        if (duplicate) {
          throw new ChymeError(
            `${options.driver}:${normalized} is already a source of "${project.slug}".`,
          );
        }

        const kinds = parseKinds(options.kinds);
        project.sources.push({
          driver: options.driver,
          key: normalized,
          kinds: kinds ?? DEFAULT_KINDS,
        });

        saveConfig(config, path);
        note(`Added ${options.driver}:${normalized} to "${project.slug}"`);
        note(`Next: chyme sync --project ${project.slug}`);
      }),
    );

  source
    .command('list')
    .option('-p, --project <slug>', 'project to list sources for')
    .description('List a project\'s sources')
    .action((options: { project?: string }) =>
      runCommand(() => {
        const { config } = loadConfig();
        const project = selectProject(config, options.project);

        if (project.sources.length === 0) {
          note(`"${project.slug}" has no sources.`);
          note(`Add one with: chyme source add <owner/repo> --project ${project.slug}`);
          return;
        }

        for (const source of project.sources) {
          emit(`${source.driver}\t${source.key}\t${source.kinds.join(',')}`);
        }
      }),
    );

  source
    .command('remove')
    .argument('<key>')
    .option('-p, --project <slug>')
    .option('-d, --driver <driver>', 'forge driver', 'github')
    .description('Remove a source; its synced threads are dropped on the next sync')
    .action((key: string, options: { project?: string; driver: string }) =>
      runCommand(() => {
        const { config, path } = loadConfig();
        const project = selectProject(config, options.project);
        const normalized = findDriverFactory(options.driver).parseSourceKey(key);

        const index = project.sources.findIndex(
          (candidate) => candidate.driver === options.driver && candidate.key === normalized,
        );
        if (index < 0) {
          throw new NotFoundError(
            `"${project.slug}" has no source ${options.driver}:${normalized}.`,
            project.sources.length > 0
              ? `It has: ${project.sources.map((s) => `${s.driver}:${s.key}`).join(', ')}`
              : undefined,
          );
        }

        project.sources.splice(index, 1);
        saveConfig(config, path);
        note(`Removed ${options.driver}:${normalized} from "${project.slug}"`);
        note('Its synced threads are dropped on the next sync.');
      }),
    );

  program
    .command('drivers')
    .description('List available source drivers')
    .action(() => runCommand(() => { for (const id of driverIds()) emit(id); }));
}
