/**
 * Byte budgeting for rendered output.
 *
 * Chyme performs no inference of its own — the raw material goes into the
 * harness's context window, so every expansion command has to be able to cap
 * what it emits. The rule throughout: truncation is always *visible*. A
 * silently shortened diff reads as a complete one, and a digest built on it is
 * confidently wrong.
 */

export interface Truncation {
  text: string;
  truncated: boolean;
  /** Bytes dropped. Zero when nothing was cut. */
  omittedBytes: number;
}

export function byteLength(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

/**
 * Cut a string to a byte budget without splitting a multi-byte character.
 *
 * `Buffer.subarray().toString()` would happily bisect a UTF-8 sequence and
 * leave a replacement character behind, so we walk back to the last lead byte.
 */
export function truncateToBytes(input: string, maxBytes: number): Truncation {
  if (maxBytes <= 0) {
    return { text: '', truncated: input.length > 0, omittedBytes: byteLength(input) };
  }

  const buffer = Buffer.from(input, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text: input, truncated: false, omittedBytes: 0 };
  }

  let end = maxBytes;
  // Continuation bytes match 0b10xxxxxx; step back off them to a lead byte.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }

  return {
    text: buffer.subarray(0, end).toString('utf8'),
    truncated: true,
    omittedBytes: buffer.length - end,
  };
}

/**
 * Prefer cutting at a line boundary when one is close to the budget — a diff or
 * comment cut mid-line is much harder to read than one cut a few bytes early.
 * Falls back to a hard byte cut when no boundary is within `slackBytes`.
 */
export function truncateToBytesAtLine(
  input: string,
  maxBytes: number,
  slackBytes = 512,
): Truncation {
  const hard = truncateToBytes(input, maxBytes);
  if (!hard.truncated) return hard;

  const lastNewline = hard.text.lastIndexOf('\n');
  if (lastNewline < 0) return hard;

  const droppedByBacktracking = byteLength(hard.text.slice(lastNewline));
  if (droppedByBacktracking > slackBytes) return hard;

  const text = hard.text.slice(0, lastNewline);
  return {
    text,
    truncated: true,
    omittedBytes: byteLength(input) - byteLength(text),
  };
}

/** A one-line, human-readable marker naming exactly what was withheld. */
export function truncationNotice(omittedBytes: number, what: string): string {
  return `… [${formatBytes(omittedBytes)} of ${what} omitted]`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Collapse a body to its first meaningful lines for an index listing. Strips
 * blank lines and markdown quote blocks, which are usually quoted context from
 * the message above rather than new content.
 */
export function summarizeBody(body: string | null, maxChars = 240): string | null {
  if (!body) return null;

  const meaningful = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('>'))
    .join(' ');

  if (meaningful.length === 0) return null;
  if (meaningful.length <= maxChars) return meaningful;
  return `${meaningful.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Fence a body so embedded backticks can't break the surrounding markdown. */
export function fence(body: string, language = ''): string {
  let ticks = '```';
  while (body.includes(ticks)) ticks += '`';
  return `${ticks}${language}\n${body}\n${ticks}`;
}
