import type { ResolvedHit, SearchResults } from '../query/search.js';
import { byteLength } from '../util/text.js';
import { BudgetWriter, fit, type RenderOptions } from './budget.js';
import { handleOf, plural, threadStatus } from './format.js';

/**
 * Search hits, each carrying the reference needed to open it.
 *
 * A hit without a usable reference costs a round trip to act on, which is the
 * whole reason the query layer resolves them.
 */

export const DEFAULT_SEARCH_BYTES = 16_384;

/** A snippet is a pointer, not a quote; past this it stops being cheap. */
const SNIPPET_BYTES = 400;

export function renderSearch(results: SearchResults, options: RenderOptions = {}): string {
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_SEARCH_BYTES, '\n\n');
  // Worst case — no hit shown — so the notices survive whatever else does not.
  writer.reserve(byteLength(footerNotes(results, 0).join('\n')));

  writer.writeFitted(
    `# search "${results.text}" — ${plural(results.hits.length, 'hit')}`,
    'header',
  );

  if (results.hits.length === 0) {
    writer.write('Nothing in the store matches that.');
    // Through the footer, not around it: a cap or an unresolvable hit means
    // matches existed, and "nothing matches" on its own would deny them.
    footer(writer, results, 0);
    return writer.text();
  }

  let shown = 0;
  for (const hit of results.hits) {
    if (!writer.write(hitBlock(hit))) break;
    shown += 1;
  }

  footer(writer, results, shown);
  return writer.text();
}

function hitBlock(entry: ResolvedHit): string {
  const { hit, thread, event } = entry;
  const where = event
    ? `${event.kind} by ${handleOf(entry.actor)} ${hit.createdAt}`
    : `opened by ${handleOf(entry.actor)} ${hit.createdAt}`;

  const snippet = fit(hit.snippet.replaceAll('\n', ' '), SNIPPET_BYTES, 'snippet').text;

  return [
    `${entry.ref} [${threadStatus(thread)}] ${thread.title}`,
    `${where} · score ${hit.score.toFixed(2)}`,
    `> ${snippet}`,
  ].join('\n');
}

function footer(writer: BudgetWriter, results: SearchResults, shown: number): void {
  const notes = footerNotes(results, shown);
  if (notes.length > 0) writer.writeFooter(notes.join('\n'));
}

function footerNotes(results: SearchResults, shown: number): string[] {
  const notes: string[] = [];

  const dropped = results.hits.length - shown;
  if (dropped > 0) {
    notes.push(`[${dropped} of ${results.hits.length} hits not shown, lowest ranked first]`);
  }
  if (results.limited) {
    notes.push(`[capped at ${results.limit} hits; there may be more — narrow the terms or the window]`);
  }
  if (results.unresolved > 0) {
    notes.push(`[${plural(results.unresolved, 'hit')} pointed at threads no longer in the store]`);
  }

  return notes;
}
