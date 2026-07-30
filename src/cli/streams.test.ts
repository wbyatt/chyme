import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { guardPipe } from './streams.js';

function broken(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`write ${code}`);
  error.code = code;
  return error;
}

describe('guardPipe', () => {
  it('ends quietly when the reader closes the pipe', () => {
    // `chyme activity --since 30d | head -20`: head has what it wants, closes
    // the pipe, and the next write fails. Unhandled, Node turns that into a
    // stack trace over output that was in fact complete.
    const stream = new EventEmitter();
    const codes: number[] = [];
    const reported: unknown[] = [];
    guardPipe(stream, { quit: (code) => codes.push(code), report: (error) => reported.push(error) });

    stream.emit('error', broken('EPIPE'));

    expect(codes).toEqual([0]);
    expect(reported).toEqual([]);
  });

  it('still reports a write failure that is not a closed pipe', () => {
    const stream = new EventEmitter();
    const codes: number[] = [];
    const reported: unknown[] = [];
    guardPipe(stream, { quit: (code) => codes.push(code), report: (error) => reported.push(error) });

    const error = broken('ENOSPC');
    stream.emit('error', error);

    expect(codes).toEqual([1]);
    expect(reported).toEqual([error]);
  });

  it('does not itself throw on an error event, whatever the code', () => {
    const stream = new EventEmitter();
    guardPipe(stream, { quit: () => {}, report: () => {} });

    // An 'error' event with no listener is an uncaught exception; the whole
    // point of this guard is that one can never be raised from a write.
    expect(() => stream.emit('error', broken('ECONNRESET'))).not.toThrow();
  });
});
