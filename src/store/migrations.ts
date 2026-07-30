import type { Db } from './db.js';

/**
 * The schema, as an append-only list.
 *
 * Migrations are numbered from 1 and applied in order against `PRAGMA
 * user_version`. Never edit a migration that has shipped — a user's database
 * has already run it, and the only way to change what it did is another
 * migration.
 */
export interface Migration {
  version: number;
  /** Shown when a migration fails, so the user learns which step broke. */
  name: string;
  up: string | ((db: Db) => void);
}

/**
 * Timestamps are ISO 8601 UTC strings, not epoch integers: they sort
 * lexicographically, they read correctly in a `sqlite3` shell, and they are
 * exactly what the sources hand us, so nothing has to be converted twice.
 *
 * `raw_json` holds the driver's untouched payload. It is the reason a schema
 * change later does not mean re-fetching a year of history through a
 * rate-limited API.
 */
const CORE = `
CREATE TABLE project (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE source (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  driver      TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  kinds_json  TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, driver, "key")
);

CREATE TABLE actor (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  handle       TEXT NOT NULL,
  display_name TEXT,
  is_bot       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, external_id)
);

CREATE TABLE thread (
  id             INTEGER PRIMARY KEY,
  source_id      INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  external_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  state          TEXT NOT NULL,
  is_draft       INTEGER NOT NULL DEFAULT 0,
  author_id      INTEGER REFERENCES actor(id) ON DELETE SET NULL,
  url            TEXT NOT NULL,
  body           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT,
  merged_at      TEXT,
  labels_json    TEXT NOT NULL DEFAULT '[]',
  raw_json       TEXT,
  first_seen_at  TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  UNIQUE (source_id, kind, number)
);

CREATE TABLE event (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor_id    INTEGER REFERENCES actor(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  body        TEXT,
  path        TEXT,
  line        INTEGER,
  detail_json TEXT,
  raw_json    TEXT,
  UNIQUE (thread_id, external_id)
);

CREATE TABLE file_change (
  id              INTEGER PRIMARY KEY,
  thread_id       INTEGER NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  previous_path   TEXT,
  status          TEXT NOT NULL,
  additions       INTEGER NOT NULL DEFAULT 0,
  deletions       INTEGER NOT NULL DEFAULT 0,
  patch           TEXT,
  patch_truncated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (thread_id, path)
);

CREATE TABLE reference (
  id         INTEGER PRIMARY KEY,
  from_kind  TEXT NOT NULL,
  from_id    INTEGER NOT NULL,
  ref_kind   TEXT NOT NULL,
  ref_raw    TEXT NOT NULL,
  hint_json  TEXT,
  to_kind    TEXT,
  to_id      INTEGER,
  confidence REAL NOT NULL DEFAULT 0,
  UNIQUE (from_kind, from_id, ref_kind, ref_raw)
);

CREATE TABLE digest (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  params_json  TEXT,
  body_md      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE sync_cursor (
  source_id  INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, kind)
);

CREATE INDEX event_thread_created_idx  ON event (thread_id, created_at);
CREATE INDEX event_created_idx         ON event (created_at);
CREATE INDEX event_actor_idx           ON event (actor_id);
CREATE INDEX thread_source_updated_idx ON thread (source_id, updated_at);
CREATE INDEX thread_updated_idx        ON thread (updated_at);
CREATE INDEX thread_author_idx         ON thread (author_id);
CREATE INDEX file_change_thread_idx    ON file_change (thread_id);
CREATE INDEX reference_from_idx        ON reference (from_kind, from_id);
CREATE INDEX reference_to_idx          ON reference (to_kind, to_id);
CREATE INDEX digest_project_window_idx ON digest (project_id, window_end);

-- References have no foreign key on the "from" side because it is polymorphic,
-- so nothing would clean them up when a thread or event goes away. A trigger
-- rather than repository code, because deletions arrive by FK cascade from
-- source and project too, where no repository is watching.
CREATE TRIGGER reference_thread_delete AFTER DELETE ON thread BEGIN
  DELETE FROM reference WHERE from_kind = 'thread' AND from_id = old.id;
END;

CREATE TRIGGER reference_event_delete AFTER DELETE ON event BEGIN
  DELETE FROM reference WHERE from_kind = 'event' AND from_id = old.id;
END;
`;

/**
 * A plain (content-owning) FTS5 table rather than an external-content one: the
 * indexed text is a projection of several tables at once — thread titles,
 * thread bodies, event bodies — which has no single content table to point at.
 *
 * The non-body columns are UNINDEXED so they cost nothing in the term index but
 * can still be read back and filtered on without joining to the base tables.
 * `remove_diacritics 2` is the Unicode-correct setting; the default (1) mangles
 * some non-Latin scripts.
 */
const SEARCH = `
CREATE VIRTUAL TABLE search_index USING fts5(
  body,
  entity_kind UNINDEXED,
  entity_id UNINDEXED,
  thread_id UNINDEXED,
  project_id UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- The index must not outlive what it points at, or a search returns hits for
-- threads that are gone. The trigger lives in this migration rather than the
-- core one so that swapping the search implementation takes its cleanup with
-- it. Requires PRAGMA recursive_triggers, which db.ts sets, for the case where
-- the thread is itself being deleted by a cascade.
CREATE TRIGGER search_index_thread_delete AFTER DELETE ON thread BEGIN
  DELETE FROM search_index WHERE thread_id = old.id;
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core-schema', up: CORE },
  { version: 2, name: 'fts5-search-index', up: SEARCH },
];

/** The version a freshly created database ends up at. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
