import type { ProjectConfig } from '../config/schema.js';
import type { Store } from '../store/index.js';
import type { ProjectRow, SourceRow } from '../store/index.js';

/**
 * Bring the database in line with the config.
 *
 * The config is the statement of intent and this is the only direction the
 * arrow points: a source added to the file appears here, and a source removed
 * from it is dropped along with everything synced from it. That is deliberate —
 * if removing a repository from the config left its threads in the store, every
 * subsequent digest would quietly include a project the user stopped following.
 */

export interface ReconcileResult {
  project: ProjectRow;
  sources: SourceRow[];
  /** Sources dropped because the config no longer lists them. */
  removed: SourceRow[];
}

export function reconcileProject(
  store: Store,
  config: ProjectConfig,
  now: string,
): ReconcileResult {
  return store.transaction(() => {
    const project = store.projects.upsertProject(
      { slug: config.slug, name: config.name },
      now,
    );

    const sources = config.sources.map((source) =>
      store.sources.upsertSource(
        {
          projectId: project.id,
          driver: source.driver,
          key: source.key,
          kinds: source.kinds,
        },
        now,
      ),
    );

    const removed = store.sources.pruneSources(
      project.id,
      config.sources.map((source) => ({ driver: source.driver, key: source.key })),
    );

    return { project, sources, removed };
  });
}
