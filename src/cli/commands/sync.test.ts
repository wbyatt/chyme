import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/index.js';
import { syncProject, type SyncOptions, type SyncReport } from '../../sync/sync.js';
import { createInterruptHandler, registerSyncCommand } from './sync.js';

/**
 * `sync` without a source to sync.
 *
 * The engine is covered by its own tests against a fake driver; what is left
 * here is the part only the CLI owns — how a signal is handled, and what the
 * command decides to pass down. The engine and the report renderer are stubbed
 * so neither a token nor a network is involved.
 */
vi.mock('../../sync/sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/sync.js')>()),
  syncProject: vi.fn(),
}));

vi.mock('../../render/sync.js', () => ({ renderSyncReport: () => 'sync report' }));

const syncing = vi.mocked(syncProject);

function report(): SyncReport {
  return {
    projectSlug: 'platform',
    startedAt: '2026-07-29T09:00:00Z',
    finishedAt: '2026-07-29T09:00:10Z',
    sources: [],
    removedSources: [],
    aborted: false,
  };
}

let dir = '';
let previousConfig: string | undefined;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chyme-sync-'));
  previousConfig = process.env['CHYME_CONFIG'];
  previousDb = process.env['CHYME_DB'];
  process.env['CHYME_CONFIG'] = join(dir, 'config.json');
  process.env['CHYME_DB'] = join(dir, 'chyme.db');
  writeFileSync(
    process.env['CHYME_CONFIG'],
    JSON.stringify({
      version: 1,
      projects: [
        {
          slug: 'platform',
          name: 'Platform',
          sources: [{ driver: 'github', key: 'acme/api' }],
        },
      ],
    }),
  );
  syncing.mockReset();
  syncing.mockResolvedValue(report());
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env['CHYME_CONFIG'];
  else process.env['CHYME_CONFIG'] = previousConfig;
  if (previousDb === undefined) delete process.env['CHYME_DB'];
  else process.env['CHYME_DB'] = previousDb;
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function run(...argv: string[]): Promise<{ stderr: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerSyncCommand(program);

  const err: string[] = [];
  const silence = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(silence);
  process.exitCode = undefined;

  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stderr: err.join(''), exitCode: typeof exitCode === 'number' ? exitCode : undefined };
}

function optionsPassed(): SyncOptions {
  expect(syncing).toHaveBeenCalledTimes(1);
  return syncing.mock.calls[0]![4]!;
}

describe('chyme sync --since', () => {
  it('passes a resolved instant down instead of the stored watermark', async () => {
    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const result = await run('sync', '--since', '7d');

    expect(result.exitCode).toBeUndefined();
    const since = optionsPassed().since;
    expect(typeof since).toBe('string');
    expect(Math.abs(Date.parse(since!) - before)).toBeLessThan(60_000);
  });

  it('leaves the watermark alone when it is not given', async () => {
    await run('sync');
    expect(optionsPassed().since).toBeUndefined();
  });

  it('resolves `last` against the most recent saved digest', async () => {
    const store = openStore(process.env['CHYME_DB']!);
    try {
      const project = store.projects.upsertProject(
        { slug: 'platform', name: 'Platform' },
        '2026-01-01T00:00:00Z',
      );
      store.digests.insertDigest(
        {
          projectId: project.id,
          windowStart: '2026-07-01T00:00:00Z',
          windowEnd: '2026-07-20T00:00:00Z',
          bodyMd: '# Digest',
        },
        '2026-07-20T00:00:00Z',
      );
    } finally {
      store.close();
    }

    await run('sync', '--since', 'last');

    expect(optionsPassed().since).toBe('2026-07-20T00:00:00Z');
  });

  it('refuses `last` with nothing to measure from rather than syncing everything', async () => {
    const result = await run('sync', '--since', 'last');

    expect(result.stderr).toContain('no saved digest');
    expect(result.exitCode).toBe(1);
    expect(syncing).not.toHaveBeenCalled();
  });
});

describe('chyme sync interrupts', () => {
  it('leaves no SIGINT listener behind when the store will not open', async () => {
    // A directory is not a database. The listener used to be installed before
    // this could fail, and Node's terminate-on-Ctrl-C stays disabled for as
    // long as any listener is registered.
    process.env['CHYME_DB'] = dir;
    const before = process.listenerCount('SIGINT');

    const result = await run('sync');

    expect(result.exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('removes its listener after a clean run', async () => {
    const before = process.listenerCount('SIGINT');
    await run('sync');
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('aborts on the first signal and escalates on the second', () => {
    const controller = new AbortController();
    const codes: number[] = [];
    const said: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const interrupt = createInterruptHandler(controller, (code) => codes.push(code));

    try {
      interrupt();
      expect(controller.signal.aborted).toBe(true);
      // `abort()` is idempotent, so a second Ctrl-C that only called it again
      // did nothing at all — on a process whose default handler is gone.
      expect(codes).toEqual([]);

      interrupt();
      expect(codes).toEqual([130]);

      interrupt();
      expect(codes).toEqual([130, 130]);
    } finally {
      stderr.mockRestore();
    }

    expect(said[0]).toContain('finishing the current thread');
    expect(said[1]).toContain('stopping now');
  });
});
