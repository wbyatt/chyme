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
  /** Which thread kinds to pull. Discussions are opt-in; most repos don't use them. */
  kinds: z
    .array(z.enum(['pull_request', 'issue', 'discussion']))
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
   * Hard ceiling on threads fetched in a single sync run. A safety valve for a
   * first sync against a busy repo, not a normal-operation limit; when it trips
   * the run reports how many threads it left behind.
   */
  maxThreadsPerRun: z.number().int().positive().default(500),
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
