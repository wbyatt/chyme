/**
 * Error types that survive the trip to the CLI boundary with something useful
 * to say. Anything thrown that is not a ChymeError is a bug and gets a stack
 * trace; a ChymeError gets a clean message and a non-zero exit.
 */

export class ChymeError extends Error {
  override readonly name: string = 'ChymeError';

  constructor(
    message: string,
    /** Optional next step the user can actually take. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** The user asked for something that is not in the config or the store. */
export class NotFoundError extends ChymeError {
  override readonly name = 'NotFoundError';
}

/** The config file is missing, malformed, or internally inconsistent. */
export class ConfigError extends ChymeError {
  override readonly name = 'ConfigError';
}

/** A source forge rejected us, rate-limited us, or returned something unusable. */
export class DriverError extends ChymeError {
  override readonly name = 'DriverError';

  constructor(
    message: string,
    readonly driver: string,
    hint?: string,
    override readonly cause?: unknown,
  ) {
    super(message, hint);
  }
}

/**
 * A code path that exists but is not implemented yet.
 *
 * This is the only acceptable body for an unfinished function. Returning
 * plausible-looking placeholder data instead is forbidden: a digest built on
 * invented data is worse than no digest, because it is believed.
 */
export class NotImplementedError extends ChymeError {
  override readonly name = 'NotImplementedError';

  constructor(what: string) {
    super(`Not implemented: ${what}`);
  }
}
