import type { DigestMetaRow, DigestRow, ProjectRow } from '../store/index.js';
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

export function renderDigestList(
  project: ProjectRow,
  digests: readonly DigestMetaRow[],
  options: RenderOptions = {},
): string {
  const now = options.now ?? new Date();
  const writer = new BudgetWriter(options.maxBytes ?? DEFAULT_DIGEST_LIST_BYTES);
  writer.reserve(128);

  writer.writeFitted(
    `# ${project.slug} digests — ${plural(digests.length, 'saved')}`,
    'header',
  );

  if (digests.length === 0) {
    writer.write('None saved yet, so `--since last` has nothing to measure from.');
    return writer.text();
  }

  let shown = 0;
  for (const digest of digests) {
    const line = `${digest.id}  ${digest.windowStart} → ${digest.windowEnd}  saved ${stamp(digest.createdAt, now)}`;
    if (!writer.write(line)) break;
    shown += 1;
  }

  if (shown < digests.length) {
    writer.writeFooter(`[${digests.length - shown} older digests not shown]`);
  }
  return writer.text();
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
