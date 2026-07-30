# Chyme

A project digest tool. Chyme gives you an insider's view into an engineering project you need to follow in detail but aren't committing to.

## Why

If you're an architect, an SRE, an engineering manager, or an engineer on a stakeholder team, you have a standing problem: the project moves faster than you can read it. Standups tell you results, not discourse. By the time a pain point is visible in the outcomes, it's been hurting for weeks in the review comments.

Chyme pulls the *discourse* — pull requests with their reviews, inline comments, discussion threads, commit messages, and linked issues — into a local store, and hands it to an agentic harness (Claude Code, OpenCode) that composes the actual digest. You get "what happened since last Tuesday", "what's been going on with the auth refactor", or "what has Kai been working on", with the arguments and the pain points intact rather than summarized away.

Chyme deliberately does *not* try to tell you what your project's recurring problems are. Noticing those is your job; this tool exists to make the raw material legible enough that you can.

## How it's put together

Three ideas do most of the work:

**Enumeration, not similarity.** "Everything since last Tuesday" is a complete, time-bounded query, not a top-k retrieval. Chyme's primary store is a relational event log queried on time, author, path, and repository. Keyword search over the same corpus is a secondary index for topical questions. If a digest silently dropped a thread, you'd have to go read the PRs anyway — so it doesn't.

**The thread is the unit.** A commit on its own carries almost no signal about *why*. The object that carries discourse is the pull request and its orbit: the diff, the reviews, the revision history, the linked issues, the follow-up fix three days later. Chyme reifies that aggregate.

**Config is intent; the database is observed state.** Projects and sources are declared in a config file. `chyme sync` reconciles that declaration into the local database. Nothing about your project definition lives only in a database you can't read.

Chyme performs no LLM inference of its own and holds no model credentials. It gathers and structures material; the harness you point at it does the composition. That keeps the sync path cheap, deterministic, and offline-replayable.

## Requirements

- Node.js 24 or newer (Chyme uses the built-in `node:sqlite` module, so there is no native build step)
- A GitHub token with `repo` scope for the repositories you want to follow

## Install

```bash
npm install
npm run build
npm link      # optional, puts `chyme` on your PATH
```

## Configuration

Chyme reads `~/.config/chyme/config.json` (override with `$CHYME_CONFIG`). Its database lives in `~/.local/share/chyme/chyme.db` (override with `$CHYME_DATA_DIR` or `$CHYME_DB`).

```json
{
  "version": 1,
  "projects": [
    {
      "slug": "platform",
      "name": "Platform",
      "sources": [
        { "driver": "github", "key": "acme/api", "kinds": ["pull_request", "issue"] },
        { "driver": "github", "key": "acme/worker" }
      ]
    }
  ],
  "credentials": {
    "github": { "token": "${GITHUB_TOKEN}" }
  },
  "sync": {
    "includePatches": true,
    "maxPatchBytes": 65536
  }
}
```

Credential values support `${ENV_VAR}` interpolation, so your token never has to be written to disk. A referenced variable that isn't set is a hard error rather than an empty substitution — an empty token produces a 401 several layers from the cause.

One project can span many repositories, which is the normal case.

## Usage

```bash
# Define what you're following
chyme project add platform --name "Platform"
chyme source add acme/api --project platform

# Pull everything new or changed
chyme sync

# What moved, and when
chyme activity --since last
chyme activity --since 7d --author kai
chyme activity --since 2026-07-01 --repo acme/api --path src/billing

# Open one thread in full
chyme thread platform/acme/api#412 --diff --comments

# Topical search across the corpus
chyme search "migration tooling" --since 30d

# Digests you've saved
chyme digest list
chyme digest show 7
```

`--since last` means *the end of the most recent saved digest window* — "what haven't I seen" — not the last sync.

`chyme activity` returns a compact index with stable thread references and size hints; `chyme thread` expands one. That progressive disclosure is deliberate: it lets an agent plan what to open rather than pulling a week of diffs into its context on the first call.

## Use from an agentic harness

`skill/SKILL.md` is a ready-to-use skill for Claude Code and other harnesses that read skill definitions. Point your harness at it and ask for a digest in the ordinary way — the skill teaches it to sync at runtime, page through activity, and expand selectively within a byte budget.

## Extending to other sources

Sources sit behind a `ForgeDriver` interface (`src/drivers/types.ts`) with a deliberately small surface: list threads updated since a watermark, fetch one thread in full, extract references from text. GitHub is the only implementation today. Nothing outside `src/drivers/github/` knows what GitHub is, and the reference graph is stored in a forge-agnostic edge table, so an unresolvable `PROJ-88` still records that a thread points at a ticket — and becomes resolvable the day a Jira driver exists.

## Status

Early. The store, the GitHub driver, sync, query, and the CLI are implemented; expect the CLI surface to move. Read-only by design: Chyme never writes to your forges.

## Development

```bash
npm run typecheck
npm test
```

## Generative AI disclosure

This project was built collaboratively with generative AI. Design decisions were made by a human author in dialogue with Claude (Anthropic), and the large majority of the source was written by Claude Code under human direction and review. Sessions are tracked with [Entire](https://entire.io), so the development record — including the prompts and agent sessions behind each change — is part of the repository history.

If you're evaluating this code for use, treat it as you would any AI-assisted codebase: the tests and the review history are in the open, and you should read both.

## License

MIT — see [LICENSE](LICENSE).
