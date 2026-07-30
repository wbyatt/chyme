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

  it('holds the reserve back for the footer, separator included', () => {
    const writer = new BudgetWriter(40);
    // 16 for the footer plus 1 for the newline joining it on. Reserving only
    // the footer's own length leaves it a separator short, and the bytes that
    // get trimmed are the end of the notice naming what was cut.
    writer.reserve(16);
    expect(writer.write('x'.repeat(30))).toBe(false);
    expect(writer.write('x'.repeat(24))).toBe(false);
    expect(writer.write('x'.repeat(23))).toBe(true);
    writer.writeFooter('[cut]');
    expect(writer.text()).toBe(`${'x'.repeat(23)}\n[cut]`);
  });

  it('marks a footer it had to cut rather than trimming the notice silently', () => {
    // Tight enough that the footer must be cut, roomy enough for a whole notice.
    const writer = new BudgetWriter(90);
    writer.reserve(200);
    writer.write('x'.repeat(40));
    writer.writeFooter('[3 threads excluded: bot activity only, and more besides]');
    expect(writer.text()).toContain('omitted]');
    expect(byteLength(writer.text())).toBeLessThanOrEqual(90);
  });

  it('degrades to a bare ellipsis when the ceiling cannot hold a whole notice', () => {
    const writer = new BudgetWriter(48);
    writer.reserve(80);
    writer.write('x'.repeat(20));
    writer.writeFooter('[3 threads excluded: bot activity only]');
    const text = writer.text();
    // A half-written "[39 B of this notice om" would read as content.
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('notice om');
    expect(byteLength(text)).toBeLessThanOrEqual(48);
  });

  it('never exceeds its ceiling, footer included', () => {
    const writer = new BudgetWriter(30, '\n\n');
    writer.reserve(10);
    writer.write('12345678901234567890');
    writer.writeFooter('[a footer longer than the reserve held back]');
    expect(byteLength(writer.text())).toBeLessThanOrEqual(30);
  });
});
