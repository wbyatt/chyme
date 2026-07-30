import { reportError } from './output.js';

/**
 * What to do when the other end of a pipe goes away.
 *
 * `chyme activity --since 30d | head -20` is documented usage, and an agentic
 * harness that stops reading does exactly what `head` does: it closes the pipe,
 * the next write fails with EPIPE, and Node — which treats an unhandled stream
 * error as a crash — prints a stack trace over output that was in fact fine.
 * There is nobody left to tell, so the honest response is to stop quietly.
 */

/** The part of a stream this needs, so a test can hand it an EventEmitter. */
export interface ErrorEmitter {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface PipeGuardOptions {
  /** Called instead of `process.exit`, so a test does not take the runner with it. */
  quit: (code: number) => void;
  /** Silenced for stderr itself: complaining about stderr on stderr goes nowhere. */
  report?: (error: unknown) => void;
}

export function guardPipe(stream: ErrorEmitter, options: PipeGuardOptions): void {
  const report = options.report ?? reportError;
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
      options.quit(0);
      return;
    }
    // Anything else — a full disk, a closed file descriptor — is a real
    // failure, and losing it inside a stream handler would be worse than the
    // crash this function exists to prevent.
    report(error);
    options.quit(1);
  });
}

/** Both of the CLI's output streams, wired to the real process. */
export function guardOutputPipes(): void {
  guardPipe(process.stdout, { quit: (code) => process.exit(code) });
  guardPipe(process.stderr, { quit: (code) => process.exit(code), report: () => {} });
}
