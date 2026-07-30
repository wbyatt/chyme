import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../../config/load.js';
import type { ThreadKind } from '../../domain/types.js';
import { driverIds, findDriverFactory } from '../../drivers/registry.js';
import type { DriverFactory } from '../../drivers/types.js';
import { ChymeError, NotFoundError } from '../../util/errors.js';
import { selectProject } from '../context.js';
import { emit, note, runCommand } from '../output.js';

/** The config schema requires at least one kind, so the tuple shape is load-bearing. */
type Kinds = [ThreadKind, ...ThreadKind[]];

function defaultKindsFor(factory: DriverFactory): Kinds {
  const [first, ...rest] = factory.supportedKinds;
  if (first === undefined) {
    throw new ChymeError(`The ${factory.id} driver declares no thread kinds it can sync.`);
  }
  return [first, ...rest];
}

function parseKinds(input: string | undefined, factory: DriverFactory): Kinds | null {
  if (input === undefined) return null;

  const kinds = input
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);

  // Checked against this specific driver, which is stricter and more useful than
  // a global list: it catches both a typo and a kind the driver knows of but
  // cannot yet service, at config time rather than partway through a sync.
  const unsupported = kinds.filter((kind) => !factory.supportedKinds.includes(kind));
  if (unsupported.length > 0) {
    throw new ChymeError(
      `The ${factory.id} driver cannot sync ${unsupported.join(', ')}.`,
      `It supports: ${factory.supportedKinds.join(', ')}`,
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
    .option('-d, --driver <driver>', 'source driver', 'github')
    .option('--kinds <kinds>', 'comma-separated thread kinds; see `chyme drivers` for what each supports')
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

        const kinds = parseKinds(options.kinds, factory);
        project.sources.push({
          driver: options.driver,
          key: normalized,
          // Fall back to everything the driver offers rather than a hardcoded
          // pair, so a non-git source gets a sensible default too.
          kinds: kinds ?? defaultKindsFor(factory),
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
    .option('-d, --driver <driver>', 'source driver', 'github')
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
    .description('List available source drivers and the thread kinds each supports')
    .action(() =>
      runCommand(() => {
        for (const id of driverIds()) {
          emit(`${id}\t${findDriverFactory(id).supportedKinds.join(',')}`);
        }
      }),
    );
}
