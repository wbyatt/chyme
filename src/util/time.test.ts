import { describe, expect, it } from 'vitest';
import { ChymeError } from './errors.js';
import { describeAge, parseTimeSpec, toIso } from './time.js';

const NOW = new Date('2026-07-29T12:00:00Z');

describe('parseTimeSpec', () => {
  it('recognizes the deferred "last" spec', () => {
    expect(parseTimeSpec('last', NOW)).toEqual({ kind: 'last' });
    expect(parseTimeSpec('LAST', NOW)).toEqual({ kind: 'last' });
  });

  it('resolves relative offsets against the injected clock', () => {
    expect(parseTimeSpec('7d', NOW)).toEqual({ kind: 'instant', at: '2026-07-22T12:00:00Z' });
    expect(parseTimeSpec('36h', NOW)).toEqual({ kind: 'instant', at: '2026-07-28T00:00:00Z' });
    expect(parseTimeSpec('2w', NOW)).toEqual({ kind: 'instant', at: '2026-07-15T12:00:00Z' });
    expect(parseTimeSpec('30m', NOW)).toEqual({ kind: 'instant', at: '2026-07-29T11:30:00Z' });
  });

  it('reads a bare date as the start of that UTC day', () => {
    expect(parseTimeSpec('2026-07-01', NOW)).toEqual({
      kind: 'instant',
      at: '2026-07-01T00:00:00Z',
    });
  });

  it('accepts a full ISO 8601 timestamp', () => {
    expect(parseTimeSpec('2026-07-01T09:30:00Z', NOW)).toEqual({
      kind: 'instant',
      at: '2026-07-01T09:30:00Z',
    });
  });

  it('rejects nonsense rather than guessing', () => {
    expect(() => parseTimeSpec('whenever', NOW)).toThrow(ChymeError);
    expect(() => parseTimeSpec('', NOW)).toThrow(ChymeError);
    expect(() => parseTimeSpec('0d', NOW)).toThrow(/zero-length/);
  });
});

describe('toIso', () => {
  it('emits second precision with a Z suffix', () => {
    expect(toIso(new Date('2026-07-29T12:00:00.123Z'))).toBe('2026-07-29T12:00:00Z');
  });
});

describe('describeAge', () => {
  it('scales the unit to the distance', () => {
    expect(describeAge('2026-07-29T11:30:00Z', NOW)).toBe('30m ago');
    expect(describeAge('2026-07-29T02:00:00Z', NOW)).toBe('10h ago');
    expect(describeAge('2026-07-20T12:00:00Z', NOW)).toBe('9d ago');
    expect(describeAge('2026-01-01T12:00:00Z', NOW)).toBe('6mo ago');
  });

  it('does not pretend a future timestamp is an age', () => {
    expect(describeAge('2026-08-01T12:00:00Z', NOW)).toBe('in the future');
  });
});
