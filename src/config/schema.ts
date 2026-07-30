import { z } from 'zod';

/**
 * The config file is the declarative statement of *intent*: which projects
 * exist, which sources feed them, how to authenticate. The database is derived
 * observed state. `chyme sync` reconciles the former into the latter, which
 * means a source can be added, removed, or renamed by editing this file alone.
 */

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export const sourceConfigSchema = z.object({
  /** Driver id, e.g. 'github'. */
  driver: z.string().min(1),
  /** Driver-interpreted source key, e.g. 'owner/repo'. */
  key: z.string().min(1),
  /**
   * Which thread kinds to pull. An open vocabulary, validated against the
   * driver rather than a fixed enum here — a Jira driver's `ticket` is as
   * legitimate a kind as a forge's `pull_request`, and this file has no business
   * knowing the difference. `chyme source add` checks the kinds against the
   * named driver, and sync refuses a kind the driver cannot service.
   */
  kinds: z
    .array(z.string().min(1))
    .nonempty()
    .default(['pull_request', 'issue']),
});

export const projectConfigSchema = z.object({
  slug: z
    .string()
    .regex(SLUG, 'must be lowercase alphanumeric, optionally with . _ or -'),
  name: z.string().min(1),
  sources: z.array(sourceConfigSchema).default([]),
});

export const syncConfigSchema = z.object({
  /** Whether to store diff hunks. Turning this off makes syncs much smaller. */
  includePatches: z.boolean().default(true),
  /** Per-file patch cap in bytes. Oversized patches are recorded as truncated, never as empty. */
  maxPatchBytes: z.number().int().positive().default(65_536),
  /**
   * Ceiling on threads *written* per source, per thread kind, in one sync run.
   *
   * A backstop, not the mechanism that keeps a first sync affordable — that is
   * `firstSyncSince`. It bounds detail fetches only; a driver may still have to
   * page a listing to discover what changed. When it trips, the run says so and
   * the watermark is still accurate, so syncing again continues where it
   * stopped.
   */
  maxThreadsPerRun: z.number().int().positive().default(500),

  /**
   * How far back a *first* sync of a source reads. Null means all history.
   *
   * Bounded by default because reading a source's entire history is the wrong
   * default for a digest tool: it is slow, it can hold a very large repository's
   * summaries in memory at once, and if `maxThreadsPerRun` trips during it the
   * store fills with the oldest threads — leaving `activity --since 7d` empty on
   * a store that looks populated. Reach further back deliberately with
   * `chyme sync --since <when>`.
   */
  firstSyncSince: z.string().nullable().default('90d'),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  /** Overrides the default XDG data directory. */
  dataDir: z.string().optional(),
  projects: z.array(projectConfigSchema).default([]),
  /**
   * Per-driver credentials, keyed by driver id. String values support
   * `${ENV_VAR}` interpolation so tokens need never be written to disk.
   */
  credentials: z.record(z.record(z.unknown())).default({}),
  sync: syncConfigSchema.default({}),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export type ChymeConfig = z.infer<typeof configSchema>;

export function defaultConfig(): ChymeConfig {
  return configSchema.parse({});
}
