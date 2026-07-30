import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type ProjectRow, type SourceRow, type Store } from '../store/index.js';
import { registerActivityCommand } from './commands/activity.js';
import { registerDigestCommands } from './commands/digest.js';
import { registerSearchCommand } from './commands/search.js';
import { registerThreadCommand } from './commands/thread.js';

/**
 * The CLI exercised the way it is used: a real config file, a real store on
 * disk, and whole commands parsed from argv.
 *
 * These are here because the bugs they cover only exist at this seam — a page
 * reported as a total, a `--project` typo swallowed by a catch, a window
 * re-resolved between two commands. Every one of them is invisible to a test of
 * the query or the renderer alone.
 *
 * `sync` is not among them: it needs a driver and a token, and nothing it does
 * is exercisable without reaching a real source.
 */

interface Run {
  stdout: string;
  stderr: string;
  /** Undefined for a clean run; commands set 1 through `runCommand`. */
  exitCode: number | undefined;
}

let dir = '';
let previousConfig: string | undefined;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chyme-cli-'));
  previousConfig = process.env['CHYME_CONFIG'];
  previousDb = process.env['CHYME_DB'];
  process.env['CHYME_CONFIG'] = join(dir, 'config.json');
  process.env['CHYME_DB'] = join(dir, 'chyme.db');
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env['CHYME_CONFIG'];
  else process.env['CHYME_CONFIG'] = previousConfig;
  if (previousDb === undefined) delete process.env['CHYME_DB'];
  else process.env['CHYME_DB'] = previousDb;
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface ProjectSpec {
  slug: string;
  sources?: string[];
}

function writeConfig(projects: ProjectSpec[]): void {
  writeFileSync(
    process.env['CHYME_CONFIG']!,
    `${JSON.stringify(
      {
        version: 1,
        projects: projects.map((project) => ({
          slug: project.slug,
          name: project.slug,
          sources: (project.sources ?? []).map((key) => ({ driver: 'github', key })),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

/** Open the same database the commands will, write to it, and let go of it. */
function seed(write: (store: Store) => void): void {
  const store = openStore(process.env['CHYME_DB']!);
  try {
    write(store);
  } finally {
    store.close();
  }
}

/** What `chyme sync` would have left behind for one project. */
function seedProject(
  store: Store,
  slug: string,
  sourceKeys: string[] = [],
): { project: ProjectRow; sources: SourceRow[] } {
  const project = store.projects.upsertProject({ slug, name: slug }, '2026-01-01T00:00:00Z');
  const sources = sourceKeys.map((key) =>
    store.sources.upsertSource(
      { projectId: project.id, driver: 'github', key, kinds: ['pull_request', 'issue'] },
      '2026-01-01T00:00:00Z',
    ),
  );
  return { project, sources };
}

function seedThread(store: Store, source: SourceRow, number: number, at: string): void {
  store.threads.upsertThread(
    source.id,
    {
      externalId: `pr_${source.key}_${number}`,
      kind: 'pull_request',
      number,
      title: `Thread ${number}`,
      state: 'open',
      isDraft: false,
      author: { externalId: 'U_ada', handle: 'ada', displayName: null, isBot: false },
      url: `https://example.test/${source.key}/pull/${number}`,
      body: 'An opening description.',
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      mergedAt: null,
      labels: [],
      raw: null,
    },
    at,
  );
}

async function run(...argv: string[]): Promise<Run> {
  const program = new Command();
  program.exitOverride();
  registerActivityCommand(program);
  registerThreadCommand(program);
  registerSearchCommand(program);
  registerDigestCommands(program);

  const out: string[] = [];
  const err: string[] = [];
  const capture = (into: string[]) =>
    ((chunk: unknown) => {
      into.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture(out));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(err));
  process.exitCode = undefined;

  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return {
    stdout: out.join(''),
    stderr: err.join(''),
    exitCode: typeof exitCode === 'number' ? exitCode : undefined,
  };
}

/** The `window:` line `activity` prints for `digest save --window`. */
function windowLine(stderr: string): string {
  const match = /^window: (\S+)$/m.exec(stderr);
  expect(match, `no window line in:\n${stderr}`).not.toBeNull();
  return match![1]!;
}

function bodyFile(text = '# Digest\n\nThe rate limiter argument continued.\n'): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, text);
  return path;
}

describe('chyme digest list', () => {
  beforeEach(() => {
    writeConfig([{ slug: 'platform', sources: ['acme/api'] }]);
    seed((store) => {
      const { project } = seedProject(store, 'platform', ['acme/api']);
      for (let day = 1; day <= 25; day += 1) {
        const start = `2026-06-${String(day).padStart(2, '0')}T00:00:00Z`;
        const end = `2026-06-${String(day + 1).padStart(2, '0')}T00:00:00Z`;
        store.digests.insertDigest(
          { projectId: project.id, windowStart: start, windowEnd: end, bodyMd: `# ${day}` },
          end,
        );
      }
    });
  });

  it('reports how many exist, not how many the page holds', async () => {
    const result = await run('digest', 'list');

    // The default limit is a page, and a page that calls itself the total is
    // the one kind of truncation Chyme is not allowed to do quietly.
    expect(result.stdout).toContain('# platform digests — 20 of 25 saved');
    expect(result.stdout).toContain('[5 older digests not listed — raise --limit]');
    expect(result.stdout).not.toContain('saveds');
    expect(result.exitCode).toBeUndefined();
  });

  it('drops the marker once the limit covers everything', async () => {
    const result = await run('digest', 'list', '--limit', '30');

    expect(result.stdout).toContain('# platform digests — 25 saved');
    expect(result.stdout).not.toContain('not listed');
  });
});

describe('chyme digest save', () => {
  beforeEach(() => {
    writeConfig([{ slug: 'platform', sources: ['acme/api'] }]);
    seed((store) => {
      const { sources } = seedProject(store, 'platform', ['acme/api']);
      seedThread(store, sources[0]!, 412, '2026-07-10T00:00:00Z');
    });
  });

  it('stores exactly the window activity reported', async () => {
    const index = await run(
      'activity',
      '--since',
      '2026-07-01T00:00:00Z',
      '--until',
      '2026-07-20T00:00:00Z',
    );
    const window = windowLine(index.stderr);
    expect(window).toBe('2026-07-01T00:00:00Z..2026-07-20T00:00:00Z');

    const saved = await run('digest', 'save', '--window', window, '--file', bodyFile());
    expect(saved.exitCode).toBeUndefined();

    seed((store) => {
      const project = store.projects.requireProject('platform');
      const digest = store.digests.latestDigest(project.id)!;
      // The end of the saved window is where the reading stopped, so the next
      // `--since last` starts there and nothing falls between the two.
      expect(digest.windowStart).toBe('2026-07-01T00:00:00Z');
      expect(digest.windowEnd).toBe('2026-07-20T00:00:00Z');
    });
  });

  it('leaves a gap when the window is described again instead of handed back', async () => {
    const saved = await run(
      'digest',
      'save',
      '--since',
      '2026-07-01T00:00:00Z',
      '--file',
      bodyFile(),
    );

    seed((store) => {
      const project = store.projects.requireProject('platform');
      const digest = store.digests.latestDigest(project.id)!;
      // Re-resolved to the moment of saving rather than to the moment of
      // reading — still the behaviour of a bare `--since`, but no longer silent.
      expect(digest.windowEnd > '2026-07-20T00:00:00Z').toBe(true);
    });
    expect(saved.stderr).toContain('ends now, not where the reading stopped');
  });

  it('reports the window it read even when the window ends now', async () => {
    const index = await run('activity', '--since', '7d');
    const window = windowLine(index.stderr);

    const [since, until] = window.split('..');
    expect(Date.parse(since!)).toBeLessThan(Date.parse(until!));
    expect(Date.now() - Date.parse(until!)).toBeLessThan(60_000);
  });

  it('refuses a window given twice over', async () => {
    const result = await run(
      'digest',
      'save',
      '--window',
      '2026-07-01T00:00:00Z..2026-07-20T00:00:00Z',
      '--since',
      '7d',
      '--file',
      bodyFile(),
    );

    expect(result.stderr).toContain('not both');
    expect(result.exitCode).toBe(1);
  });

  it('asks for a window rather than inventing one', async () => {
    const result = await run('digest', 'save', '--file', bodyFile());

    expect(result.stderr).toContain('needs the window this digest covers');
    expect(result.exitCode).toBe(1);
  });

  it('says so instead of blocking on a terminal with nothing piped in', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const result = await run('digest', 'save', '--since', '7d');

      expect(result.stderr).toContain('Nothing was piped in');
      expect(result.exitCode).toBe(1);
    } finally {
      if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe('chyme thread', () => {
  beforeEach(() => {
    writeConfig([
      { slug: 'platform', sources: ['acme/api'] },
      { slug: 'infra', sources: ['acme/terraform'] },
    ]);
    seed((store) => {
      const { sources } = seedProject(store, 'platform', ['acme/api']);
      seedThread(store, sources[0]!, 412, '2026-07-10T00:00:00Z');
      seedProject(store, 'infra', ['acme/terraform']);
    });
  });

  it('names an unknown --project instead of blaming the reference', async () => {
    const result = await run('thread', '#412', '--project', 'platfrom');

    // The catch here exists to tolerate an unresolved *default* project. It used
    // to swallow this too, and reported "No thread #412" for a thread that
    // exists in a project the user simply misspelled.
    expect(result.stderr).toContain('No project "platfrom" in the config.');
    expect(result.stderr).not.toContain('No thread');
    expect(result.exitCode).toBe(1);
  });

  it('still resolves a fully qualified reference with several projects configured', async () => {
    const result = await run('thread', 'platform/acme/api#412');

    expect(result.stdout).toContain('# platform/acme/api#412');
    expect(result.exitCode).toBeUndefined();
  });
});

describe('chyme search', () => {
  beforeEach(() => {
    writeConfig([
      { slug: 'platform', sources: ['acme/api'] },
      { slug: 'infra', sources: ['acme/terraform'] },
    ]);
    seed((store) => {
      seedProject(store, 'platform', ['acme/api']);
      seedProject(store, 'infra', ['acme/terraform']);
    });
  });

  it('names an unknown --project instead of searching everything', async () => {
    const result = await run('search', 'limiter', '--project', 'platfrom');

    expect(result.stderr).toContain('No project "platfrom" in the config.');
    expect(result.exitCode).toBe(1);
  });

  it('searches every project when no default can be chosen', async () => {
    const result = await run('search', 'limiter');

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
  });
});
