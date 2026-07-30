import { ChymeError } from '../util/errors.js';

/**
 * The stdout/stderr split is a contract, not a style choice.
 *
 * Chyme's output is read by an agentic harness as often as by a person, so
 * stdout carries *only* the requested data and nothing else. Progress,
 * warnings, and errors go to stderr, where they inform a human without
 * corrupting a pipe.
 */

export function emit(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`warning: ${text}\n`);
}

/**
 * Render an error at the CLI boundary.
 *
 * A ChymeError is something we anticipated and can explain, so it prints as a
 * message plus its actionable hint. Anything else is a bug, and prints its
 * stack — swallowing that would just make the next one harder to find.
 */
export function reportError(error: unknown): void {
  if (error instanceof ChymeError) {
    process.stderr.write(`error: ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`  ${error.hint}\n`);
    }
    return;
  }

  if (error instanceof Error) {
    process.stderr.write(`error: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return;
  }

  process.stderr.write(`error: ${String(error)}\n`);
}

/** Wrap a command body so thrown errors become clean exits rather than traces. */
export async function runCommand(body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}
