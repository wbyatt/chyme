import { byteLength, truncateToBytes, truncateToBytesAtLine, truncationNotice } from '../util/text.js';

/**
 * Budget accounting for renderers.
 *
 * Everything Chyme prints lands in a context window, so every renderer works to
 * a byte ceiling. The rule that makes a ceiling safe rather than dangerous:
 * whatever is cut is *named*. A quietly shortened list reads as a complete one,
 * and the digest built on it is confidently wrong.
 */

export interface RenderOptions {
  /** Hard ceiling on the returned text. */
  maxBytes?: number;
  /** Injected for tests and reproducible output; defaults to the wall clock. */
  now?: Date;
}

export interface Fitted {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

/**
 * Cut `text` to `maxBytes` *including* the notice saying it was cut, so a caller
 * that fits the result into a budget cannot be surprised by the marker pushing
 * it back over.
 */
export function fit(text: string, maxBytes: number, what: string): Fitted {
  if (byteLength(text) <= maxBytes) return { text, truncated: false, omittedBytes: 0 };

  // The notice's length depends on how much was dropped, which is not known
  // until the cut is made; size it against the worst case plus a little slack,
  // since `formatBytes` is not monotonic in string length ("999.9 KB" is longer
  // than "1.0 MB").
  const room = byteLength(truncationNotice(byteLength(text), what)) + 8;
  const cut = truncateToBytesAtLine(text, Math.max(0, maxBytes - room));
  const notice = truncationNotice(cut.omittedBytes, what);
  const joined = cut.text === '' ? notice : `${cut.text}\n${notice}`;

  if (byteLength(joined) <= maxBytes) {
    return { text: joined, truncated: true, omittedBytes: cut.omittedBytes };
  }

  // The ceiling cannot hold a whole notice. Clamping the sentence mid-word
  // produces "… [39 B of this notice om", which reads as content rather than as
  // a marker — the one truncation in the system that must never be mistakable.
  // A bare ellipsis says the same thing unambiguously in three bytes.
  const ellipsis = '…';
  const ellipsisBytes = byteLength(ellipsis);
  if (maxBytes < ellipsisBytes) {
    return { text: '', truncated: true, omittedBytes: byteLength(text) };
  }

  const minimal = truncateToBytes(text, maxBytes - ellipsisBytes);
  return {
    text: `${minimal.text}${ellipsis}`,
    truncated: true,
    omittedBytes: byteLength(text) - byteLength(minimal.text),
  };
}

/**
 * Blocks joined by newlines, written only while they fit whole.
 *
 * Partial blocks are refused rather than trimmed because the units here are
 * meaningful — one thread, one comment, one file — and half of one is worse
 * than a line saying it was left out.
 */
export class BudgetWriter {
  private readonly blocks: string[] = [];
  private used = 0;
  private reserved = 0;

  constructor(
    private readonly maxBytes: number,
    /** `\n\n` for prose sections, `\n` for line-per-row listings. */
    private readonly separator = '\n',
  ) {}

  /**
   * Hold bytes back for the footer, which callers size from the longest footer
   * they could end up writing — the notices naming what was cut are the one
   * thing that must never itself be cut. Capped at half the budget so a
   * pathologically small ceiling still shows some content.
   */
  reserve(bytes: number): void {
    if (bytes <= 0) return;
    // Plus a separator: the footer is appended as another block, so reserving
    // only its own length leaves it one separator short and the last bytes of
    // the notice — the part naming what was cut — get trimmed off.
    const withSeparator = bytes + byteLength(this.separator);
    this.reserved += Math.min(withSeparator, Math.floor(this.maxBytes * 0.5));
  }

  /**
   * Give the reserve back so it can be spent on ordinary writes.
   *
   * For renderers that put their must-not-be-quiet lines *last* but size the
   * reserve for them up front.
   */
  release(): void {
    this.reserved = 0;
  }

  get remaining(): number {
    return Math.max(0, this.maxBytes - this.reserved - this.used);
  }

  /** True when the block fit and was written; false when nothing was written. */
  write(block: string): boolean {
    if (block === '') return true;
    const cost = this.cost(block);
    if (cost > this.remaining) return false;
    this.blocks.push(block);
    this.used += cost;
    return true;
  }

  /**
   * Write whatever fits, marked. For the one block that must appear — a header,
   * or the body of a stored digest — where an empty output would be worse.
   */
  writeFitted(block: string, what: string): boolean {
    const fitted = fit(block, this.remaining, what);
    this.write(fitted.text);
    return !fitted.truncated;
  }

  /** Spend the reserve. Footers say what was left out, so they outrank content. */
  writeFooter(block: string): void {
    const separator = this.blocks.length > 0 ? byteLength(this.separator) : 0;
    const room = Math.max(0, this.maxBytes - this.used - separator);
    // `fit`, not a bare truncation: at a ceiling too small even for the notices,
    // the notices themselves get cut, and a half-written "[3 threads exclu" is
    // the one truncation in the system that would otherwise go unmarked.
    const text = fit(block, room, 'this notice').text;
    if (text === '') return;
    this.blocks.push(text);
    this.used += this.cost(text);
    this.reserved = Math.max(0, this.reserved - this.cost(text));
  }

  private cost(block: string): number {
    return byteLength(block) + (this.blocks.length > 0 ? byteLength(this.separator) : 0);
  }

  text(): string {
    return this.blocks.join(this.separator);
  }
}
