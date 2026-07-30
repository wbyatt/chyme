#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerActivityCommand } from './commands/activity.js';
import { registerDigestCommands } from './commands/digest.js';
import { registerProjectCommands } from './commands/project.js';
import { registerSearchCommand } from './commands/search.js';
import { registerSourceCommands } from './commands/source.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerThreadCommand } from './commands/thread.js';
import { reportError } from './output.js';
import { guardOutputPipes } from './streams.js';

/**
 * Read at runtime rather than imported, so the version cannot drift from
 * package.json and so package.json stays outside the TypeScript rootDir. The
 * relative path resolves identically from src/cli and dist/cli.
 */
function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Before anything is written: a reader that stops reading — `| head -20`, or a
// harness that has enough — must not turn into a stack trace.
guardOutputPipes();

const program = new Command();

program
  .name('chyme')
  .description(
    "A project digest tool: an insider's view into a project you follow but aren't committing to.",
  )
  .version(version())
  .showHelpAfterError();

registerProjectCommands(program);
registerSourceCommands(program);
registerSyncCommand(program);
registerActivityCommand(program);
registerThreadCommand(program);
registerSearchCommand(program);
registerDigestCommands(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
