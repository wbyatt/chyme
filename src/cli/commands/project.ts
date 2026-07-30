import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../../config/load.js';
import { projectConfigSchema } from '../../config/schema.js';
import { ChymeError, NotFoundError } from '../../util/errors.js';
import { openStoreFor } from '../context.js';
import { emit, note, runCommand } from '../output.js';

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Define the projects Chyme follows');

  project
    .command('add')
    .argument('<slug>', 'short identifier, e.g. platform')
    .requiredOption('--name <name>', 'human-readable name')
    .description('Add a project to the config')
    .action((slug: string, options: { name: string }) =>
      runCommand(() => {
        const { config, path } = loadConfig();

        if (config.projects.some((candidate) => candidate.slug === slug)) {
          throw new ChymeError(
            `Project "${slug}" already exists.`,
            'Add repositories to it with: chyme source add <owner/repo> --project ' + slug,
          );
        }

        const parsed = projectConfigSchema.safeParse({
          slug,
          name: options.name,
          sources: [],
        });
        if (!parsed.success) {
          throw new ChymeError(
            `Invalid project: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          );
        }

        config.projects.push(parsed.data);
        saveConfig(config, path);
        note(`Added project "${slug}" to ${path}`);
        note(`Next: chyme source add <owner/repo> --project ${slug}`);
      }),
    );

  project
    .command('list')
    .description('List configured projects')
    .action(() =>
      runCommand(() => {
        const { config, path, exists } = loadConfig();

        if (config.projects.length === 0) {
          note(exists ? `No projects configured in ${path}` : `No config at ${path}`);
          note('Add one with: chyme project add <slug> --name "<name>"');
          return;
        }

        for (const project of config.projects) {
          const sources = project.sources.length;
          emit(
            `${project.slug}\t${project.name}\t${sources} source${sources === 1 ? '' : 's'}`,
          );
        }
      }),
    );

  project
    .command('remove')
    .argument('<slug>')
    .option('--keep-data', 'leave synced threads in the database')
    .description('Remove a project from the config and drop what was synced for it')
    .action((slug: string, options: { keepData?: boolean }) =>
      runCommand(() => {
        const { config, path } = loadConfig();
        const index = config.projects.findIndex((candidate) => candidate.slug === slug);
        if (index < 0) {
          throw new NotFoundError(`No project "${slug}" in the config.`);
        }

        config.projects.splice(index, 1);
        saveConfig(config, path);
        note(`Removed project "${slug}" from ${path}`);

        // Sync prunes sources within a project it still knows about; a project
        // removed outright has nothing left to run that pass, so its rows are
        // dropped here or they linger forever.
        if (!options.keepData) {
          const store = openStoreFor(config);
          try {
            const stored = store.projects.findProject(slug);
            if (stored && store.projects.deleteProject(stored.id)) {
              note('Dropped its synced threads from the database.');
            }
          } finally {
            store.close();
          }
        }
      }),
    );
}
