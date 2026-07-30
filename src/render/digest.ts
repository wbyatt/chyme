import type { DigestMetaRow, DigestRow, ProjectRow } from '../store/index.js';
import { byteLength } from '../util/text.js';
import { BudgetWriter, type RenderOptions } from './budget.js';
import { plural, stamp } from './format.js';

/**
 * Saved digests: the list, and one in full.
 *
 * A stored digest is already prose someone wrote and may act on, so it is
 * reproduced verbatim. When the budget cannot hold it, the cut is marked rather
 * than being allowed to read as the end of the text.
 */

export const DEFAULT_DIGEST_BYTES = 65_536;
export const DEFAULT_DIGEST_LIST_BYTES = 8_192;

export interface DigestListOptions extends RenderOptions {
  /**
   * How many the project has, when `digests` is only a page of them. Defaults
   * to the page's own length, for a caller that fetched every one.
   */
  total?: number;
}

export function renderDigestList(
  project: ProjectRow,
  digests: readonly DigestMetaRow[],
  options: DigestListOptions = {},
): string {
  const now = options.now ?? new Date();
  const total = Math.max(options.total ?? digests.length, digests.length);
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_DIGEST_LIST_BYTES);
  // Sized from the worst case — nothing shown at all — so the lines saying what
  // is missing can never themselves be what goes missing.
  writer.reserve(byteLength(footerNotes(0, digests.length, total).join('\n')));

  // Two numbers when a page was fetched, because "20 saved" over the first 20 of
  // 50 is not a shortened answer, it is a wrong one.
  writer.writeFitted(
    total > digests.length
      ? `# ${project.slug} digests — ${digests.length} of ${total} saved`
      : `# ${project.slug} digests — ${total} saved`,
    'header',
  );

  if (total === 0) {
    writer.write('None saved yet, so `--since last` has nothing to measure from.');
    return writer.text();
  }

  let shown = 0;
  for (const digest of digests) {
    const line = `${digest.id}  ${digest.windowStart} → ${digest.windowEnd}  saved ${stamp(digest.createdAt, now)}`;
    if (!writer.write(line)) break;
    shown += 1;
  }

  const notes = footerNotes(shown, digests.length, total);
  if (notes.length > 0) writer.writeFooter(notes.join('\n'));
  return writer.text();
}

/**
 * The two ways a listing can be short of the truth, kept apart: the budget cut
 * rows off the page, and the page itself is not the whole set. They take
 * different remedies, so telling the reader "not shown" without saying which
 * would leave them guessing at the flag to raise.
 */
function footerNotes(shown: number, listed: number, total: number): string[] {
  const notes: string[] = [];

  const cut = listed - shown;
  if (cut > 0) {
    notes.push(`[${cut} of ${listed} listed digests not shown — raise the byte budget]`);
  }

  const beyond = total - listed;
  if (beyond > 0) {
    notes.push(`[${plural(beyond, 'older digest')} not listed — raise --limit]`);
  }

  return notes;
}

export function renderDigest(
  project: ProjectRow,
  digest: DigestRow,
  options: RenderOptions = {},
): string {
  const now = options.now ?? new Date();
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_DIGEST_BYTES);

  writer.writeFitted(
    [
      `# ${project.slug} digest ${digest.id}`,
      `${digest.windowStart} → ${digest.windowEnd} · saved ${stamp(digest.createdAt, now)}`,
    ].join('\n'),
    'header',
  );

  writer.writeFitted(digest.bodyMd, 'digest body');
  return writer.text();
}
