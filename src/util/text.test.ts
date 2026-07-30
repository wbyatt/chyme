import { describe, expect, it } from 'vitest';
import {
  byteLength,
  fence,
  summarizeBody,
  truncateToBytes,
  truncateToBytesAtLine,
} from './text.js';

describe('truncateToBytes', () => {
  it('leaves a string under budget untouched', () => {
    const result = truncateToBytes('hello', 100);
    expect(result).toEqual({ text: 'hello', truncated: false, omittedBytes: 0 });
  });

  it('reports the exact number of bytes dropped', () => {
    const result = truncateToBytes('abcdefghij', 4);
    expect(result.text).toBe('abcd');
    expect(result.truncated).toBe(true);
    expect(result.omittedBytes).toBe(6);
  });

  it('never bisects a multi-byte character', () => {
    // Each emoji is 4 bytes; a budget of 6 must not split the second one.
    const input = '🙂🙂';
    const result = truncateToBytes(input, 6);
    expect(result.text).toBe('🙂');
    expect(result.text).not.toContain('�');
    expect(byteLength(result.text)).toBeLessThanOrEqual(6);
    expect(result.omittedBytes).toBe(4);
  });

  it('treats a zero budget as dropping everything, visibly', () => {
    const result = truncateToBytes('abc', 0);
    expect(result).toEqual({ text: '', truncated: true, omittedBytes: 3 });
  });

  it('accounts for every byte of the input', () => {
    const input = 'héllo wörld, a longer string with ünicode';
    const result = truncateToBytes(input, 12);
    expect(byteLength(result.text) + result.omittedBytes).toBe(byteLength(input));
  });
});

describe('truncateToBytesAtLine', () => {
  it('backs up to a line boundary when one is within slack', () => {
    const input = 'line one\nline two\nline three';
    const result = truncateToBytesAtLine(input, 20, 512);
    expect(result.text).toBe('line one\nline two');
    expect(result.truncated).toBe(true);
  });

  it('falls back to a hard cut when the boundary is too far back', () => {
    const input = `${'x'.repeat(200)}\n${'y'.repeat(200)}`;
    const result = truncateToBytesAtLine(input, 350, 10);
    expect(byteLength(result.text)).toBe(350);
    expect(result.truncated).toBe(true);
  });

  it('still accounts for every byte after backtracking', () => {
    const input = 'alpha\nbeta\ngamma\ndelta';
    const result = truncateToBytesAtLine(input, 14);
    expect(byteLength(result.text) + result.omittedBytes).toBe(byteLength(input));
  });
});

describe('summarizeBody', () => {
  it('returns null for empty or quote-only bodies', () => {
    expect(summarizeBody(null)).toBeNull();
    expect(summarizeBody('')).toBeNull();
    expect(summarizeBody('> quoted context\n> more quoting')).toBeNull();
  });

  it('drops quoted lines and collapses whitespace', () => {
    expect(summarizeBody('> they said this\n\nI disagree, here is why')).toBe(
      'I disagree, here is why',
    );
  });

  it('ellipsizes past the character budget', () => {
    const result = summarizeBody('a'.repeat(500), 50);
    expect(result).toHaveLength(50);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('fence', () => {
  it('lengthens the fence so embedded backticks cannot escape it', () => {
    const body = 'here is a ``` fence inside';
    const result = fence(body);
    expect(result.startsWith('````')).toBe(true);
    expect(result.endsWith('````')).toBe(true);
  });
});
