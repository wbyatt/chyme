import { describe, expect, it } from 'vitest';
import { byteLength } from '../util/text.js';
import { BudgetWriter, fit } from './budget.js';

describe('fit', () => {
  it('leaves text that already fits alone', () => {
    expect(fit('short', 100, 'text')).toEqual({ text: 'short', truncated: false, omittedBytes: 0 });
  });

  it('counts the notice inside the budget it was given', () => {
    for (const maxBytes of [40, 64, 128, 1000]) {
      const fitted = fit('line of text\n'.repeat(200), maxBytes, 'body');
      expect(byteLength(fitted.text), `budget ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      expect(fitted.truncated).toBe(true);
    }
  });

  it('names what it dropped', () => {
    const fitted = fit('x'.repeat(5000), 500, 'the diff');
    expect(fitted.text).toContain('of the diff omitted');
    expect(fitted.omittedBytes).toBeGreaterThan(4000);
  });

  it('does not split a multi-byte character', () => {
    const fitted = fit('é'.repeat(200), 51, 'text');
    expect(fitted.text).not.toContain('�');
    expect(byteLength(fitted.text)).toBeLessThanOrEqual(51);
  });
});

describe('BudgetWriter', () => {
  it('writes a block whole or not at all', () => {
    const writer = new BudgetWriter(20);
    expect(writer.write('12345678')).toBe(true);
    expect(writer.write('a block that is far too long')).toBe(false);
    expect(writer.text()).toBe('12345678');
  });

  it('holds the reserve back for the footer', () => {
    const writer = new BudgetWriter(40);
    writer.reserve(16);
    expect(writer.write('x'.repeat(30))).toBe(false);
    expect(writer.write('x'.repeat(24))).toBe(true);
    writer.writeFooter('[cut]');
    expect(writer.text()).toBe(`${'x'.repeat(24)}\n[cut]`);
  });

  it('never exceeds its ceiling, footer included', () => {
    const writer = new BudgetWriter(30, '\n\n');
    writer.reserve(10);
    writer.write('12345678901234567890');
    writer.writeFooter('[a footer longer than the reserve held back]');
    expect(byteLength(writer.text())).toBeLessThanOrEqual(30);
  });
});
