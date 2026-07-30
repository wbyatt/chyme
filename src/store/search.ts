import { ChymeError } from '../util/errors.js';
import { int, real, text, type Row } from './columns.js';
import { transaction, type Db } from './db.js';

/**
 * Full-text search over the discourse record.
 *
 * This is an interface with one implementation on purpose. FTS5 answers "who
 * mentioned the rate limiter" well and "what was the argument about
 * performance" badly, and the second question is the one a digest actually
 * needs. sqlite-vec will land as a second implementation — the database is
 * already opened with extension loading enabled — and the seam is here so that
 * happens without callers learning about it.
 *
 * The unit of indexing is therefore a whole thread, not a row: an implementation
 * that chunks and embeds needs to see the thread's text together, and one that
 * indexes terms does not mind.
 */

export type SearchEntityKind = 'thread' | 'event';

export interface IndexedThread {
  threadId: number;
  projectId: number;
  title: string;
  body: string | null;
  createdAt: string;
}

export interface IndexedEvent {
  eventId: number;
  body: string | null;
  createdAt: string;
}

export interface SearchQuery {
  /** User-supplied text. Never passed to SQLite unescaped. */
  text: string;
  projectId?: number;
  threadId?: number;
  /** Inclusive lower bound on the entity's own timestamp. */
  since?: string;
  /** Exclusive upper bound, matching the half-open windows used elsewhere. */
  until?: string;
  kinds?: readonly SearchEntityKind[];
  limit?: number;
}

export interface SearchHit {
  entityKind: SearchEntityKind;
  entityId: number;
  threadId: number;
  projectId: number;
  createdAt: string;
  /** Matching text with the terms marked by `SNIPPET_OPEN`/`SNIPPET_CLOSE`. */
  snippet: string;
  /** Higher is more relevant. Comparable within one result set only. */
  score: number;
}

export interface SearchIndex {
  /** Replace everything indexed for a thread. Safe to call on every re-sync. */
  indexThread(thread: IndexedThread, events: readonly IndexedEvent[]): void;
  removeThread(threadId: number): void;
  search(query: SearchQuery): SearchHit[];
}

export const SNIPPET_OPEN = '[';
export const SNIPPET_CLOSE = ']';

const DEFAULT_LIMIT = 50;
const SNIPPET_TOKENS = 24;

/** A term with no letter or digit tokenizes to nothing and FTS5 rejects it. */
const HAS_TOKEN = /[\p{L}\p{N}]/u;

interface Term {
  value: string;
  prefix: boolean;
}

/**
 * Split user input into phrases, honouring double quotes.
 *
 * An unterminated quote is an error rather than a silent auto-close: the two
 * readings ("phrase up to the end" vs. "these were separate words") give
 * different results, and guessing wrong returns a confidently empty result set.
 */
function tokenize(input: string): Term[] {
  const terms: Term[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const close = input.indexOf('"', index + 1);
      if (close === -1) {
        throw new ChymeError(
          'The search query has an unclosed quote.',
          'Quote a phrase like "rate limiter", or drop the quote.',
        );
      }
      const value = input.slice(index + 1, close);
      index = close + 1;
      // A phrase may still be followed by * for a prefix match on its last word.
      const prefix = input[index] === '*';
      if (prefix) index += 1;
      terms.push({ value, prefix });
      continue;
    }

    let end = index;
    while (end < input.length && !/[\s"]/.test(input[end]!)) end += 1;
    const word = input.slice(index, end);
    index = end;

    const prefix = word.endsWith('*');
    terms.push({ value: prefix ? word.slice(0, -1) : word, prefix });
  }

  return terms.filter((term) => HAS_TOKEN.test(term.value));
}

/**
 * Turn user input into an FTS5 MATCH expression.
 *
 * Every term is emitted as a quoted phrase, so nothing the user types is FTS5
 * syntax: `foo AND bar`, `NEAR(a b)` and `col:x` all search for their literal
 * words. That loses boolean operators, which is a deliberate trade — the CLI's
 * flags express the filters that matter, and every operator left exposed is
 * another way for a query to fail with a syntax error the user cannot read.
 * Terms are implicitly ANDed, which is what people expect from a search box.
 */
export function toMatchExpression(input: string): string {
  const terms = tokenize(input);

  if (terms.length === 0) {
    throw new ChymeError(
      `"${input.trim()}" has no searchable words in it.`,
      'Search for a word or a quoted phrase, e.g. rate limiter or "rate limiter".',
    );
  }

  return terms
    .map((term) => `"${term.value.replaceAll('"', '""')}"${term.prefix ? '*' : ''}`)
    .join(' ');
}

function toHit(row: Row): SearchHit {
  return {
    entityKind: text(row, 'entity_kind') as SearchEntityKind,
    entityId: int(row, 'entity_id'),
    threadId: int(row, 'thread_id'),
    projectId: int(row, 'project_id'),
    createdAt: text(row, 'created_at'),
    snippet: text(row, 'snippet'),
    // bm25 is negative and more negative is better; flip it so callers can sort
    // descending like every other relevance score they will meet.
    score: -real(row, 'score'),
  };
}

const INSERT = `INSERT INTO search_index
  (body, entity_kind, entity_id, thread_id, project_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

export function createFtsSearchIndex(db: Db): SearchIndex {
  function removeThread(threadId: number): void {
    // FTS5 cannot index the UNINDEXED columns, so this scans. It is bounded by
    // corpus size per re-synced thread, which is fine at CLI scale and is the
    // first thing to revisit if a very large store gets slow to sync.
    db.prepare('DELETE FROM search_index WHERE thread_id = ?').run(threadId);
  }

  return {
    removeThread,

    indexThread(thread, events) {
      transaction(db, () => {
        removeThread(thread.threadId);
        const insert = db.prepare(INSERT);

        // Title and body in one row: a thread is one thing to find, and
        // splitting them would rank a thread twice for a query matching both.
        const threadText = [thread.title, thread.body ?? ''].join('\n\n').trim();
        if (threadText !== '') {
          insert.run(
            threadText,
            'thread',
            thread.threadId,
            thread.threadId,
            thread.projectId,
            thread.createdAt,
          );
        }

        for (const event of events) {
          const body = event.body?.trim();
          // State changes, labels and renames carry no prose. Indexing an empty
          // body would add rows that can never match and dilute bm25's average
          // document length.
          if (!body) continue;
          insert.run(
            body,
            'event',
            event.eventId,
            thread.threadId,
            thread.projectId,
            event.createdAt,
          );
        }
      });
    },

    search(query) {
      const match = toMatchExpression(query.text);
      const filters: string[] = ['search_index MATCH ?'];
      const args: (string | number)[] = [match];

      if (query.projectId !== undefined) {
        filters.push('project_id = ?');
        args.push(query.projectId);
      }
      if (query.threadId !== undefined) {
        filters.push('thread_id = ?');
        args.push(query.threadId);
      }
      if (query.since !== undefined) {
        filters.push('created_at >= ?');
        args.push(query.since);
      }
      if (query.until !== undefined) {
        filters.push('created_at < ?');
        args.push(query.until);
      }
      if (query.kinds && query.kinds.length > 0) {
        filters.push(`entity_kind IN (${query.kinds.map(() => '?').join(', ')})`);
        args.push(...query.kinds);
      }

      args.push(query.limit ?? DEFAULT_LIMIT);

      const sql = `SELECT entity_kind, entity_id, thread_id, project_id, created_at,
          snippet(search_index, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet,
          bm25(search_index) AS score
        FROM search_index
        WHERE ${filters.join(' AND ')}
        ORDER BY rank
        LIMIT ?`;

      try {
        return db
          .prepare(sql)
          .all(SNIPPET_OPEN, SNIPPET_CLOSE, ...args)
          .map(toHit);
      } catch (error) {
        // `toMatchExpression` should have made this unreachable. It is here
        // because "should" is doing a lot of work in that sentence, and a raw
        // SQLite message is not something to put in front of a user.
        throw new ChymeError(
          `Could not run the search for "${query.text}": ${(error as Error).message}`,
          'Try simpler terms, or quote the phrase you are looking for.',
        );
      }
    },
  };
}
