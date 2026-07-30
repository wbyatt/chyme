---
name: chyme
description: Compose a digest of what has happened in a software project you follow but do not commit to — what changed, what was argued about, and where the friction is. Use when asked for a project update, a catch-up, "what happened since...", what someone has been working on, or what the discussion around a change or topic has been. Reads pull requests and issues with their full discourse from a local Chyme store.
---

# Chyme

Chyme keeps a local store of a project's **discourse** — pull requests and issues with their reviews, inline comments, discussion, and commit messages. It performs no inference of its own. You are the part that reads the material and writes the digest.

The person asking is typically an architect, an SRE, an engineering manager, or an engineer on a stakeholder team. They are not committing to this project but need to understand it in detail: not just what shipped, but what was contested, what took three revisions, and what keeps coming up. **The arguments are the product.** A digest that lists merged PR titles has failed.

## The loop

```bash
chyme sync                              # pull anything new; safe to run every time
chyme activity --since last             # compact index of what moved
chyme thread <ref>                      # expand the ones that matter
```

Then write the digest. If the user wants it to become the new baseline for "what haven't I seen", save it with the window `activity` reported:

```bash
chyme activity --since last             # stderr: window: 2026-07-22T09:00:00Z..2026-07-29T09:00:00Z
chyme digest save --window 2026-07-22T09:00:00Z..2026-07-29T09:00:00Z < digest.md
```

`chyme activity` prints `window: <since>..<until>` to stderr — the exact half-open window it enumerated. Keep that line and hand it back as `--window`, so the saved digest covers precisely what you read. Saving with `--since last` alone instead re-resolves the end of the window to the moment of saving, and everything that moved while you were composing falls into a gap that the next `--since last` steps straight over and no digest ever enumerates.

### 1. Sync first, always

`chyme sync` is incremental and cheap on a warm store. Run it before any digest so you are not reporting on stale data. It prints progress to stderr and a report to stdout. It is read-only against every source and never writes to anyone's repository.

If it reports a failed source, say so in your digest — an unreachable repository means the digest is incomplete, and the user needs to know that rather than infer silence means quiet.

### 2. Get the index

```bash
chyme activity --since last
chyme activity --since 7d --author kai
chyme activity --since 2026-07-01 --repo acme/api --path src/billing
chyme activity --since 30d --kind issue
```

`--since last` means *the end of the most recent saved digest* — literally "what haven't I seen". It is the right default when the user asks for an update. If no digest has ever been saved, it errors; fall back to `--since 7d` and mention you did.

Each thread in the index carries a stable reference like `platform/acme/api#412`, a **disposition**, activity counts, participants, a diffstat, and a size hint (`expand ~4.2 KB`). Use the size hints to plan.

**`ongoing` matters more than `new`.** A thread created weeks ago that moved inside this window is usually where the friction is — a design argument that reopened, a fix that needed a third round. `new` is often just routine throughput.

### 3. Expand selectively

```bash
chyme thread platform/acme/api#412              # discussion and commits
chyme thread '#412' --diff                      # add diff hunks
chyme thread '#412' --no-commits --max-bytes 8000
```

Do not expand everything. Read the index, pick what carries signal — contested reviews, high revision counts, threads with many participants, anything `ongoing` — and open those. Diffs are off by default because they dominate the byte count and are rarely the answer; add `--diff` when the *what* actually matters and the discussion did not explain it.

Quote the reference in your digest so the user can go read the thread themselves.

### 4. Search when the question is topical

```bash
chyme search "migration tooling" --since 30d
chyme search flaky test fixtures
```

Keyword search over titles, descriptions, and discussion. Use it for "what's been going on with X", not for "what happened this week" — that is what `activity` is for, and `activity` is exhaustive where search is ranked.

## Rules that matter

**Never invent.** If you did not read it, it did not happen. Every claim in a digest should trace to a thread you opened or an index entry you saw.

**Truncation markers are load-bearing.** Output is byte-budgeted, and every renderer marks what it withheld: `[7 of 23 events not shown]`, `[3 more files not shown]`, `[diff not shown: ~46 KB — pass --diff]`. When you see one, either fetch the rest with a larger `--max-bytes` or a narrower query, or say in your digest that you did not read it. Never write around a gap as if it were not there.

**`activity` is exhaustive; treat it that way.** It returns every thread that moved in the window, not the top N. If the footer says threads were withheld for budget, raise `--max-bytes` or narrow the window rather than digesting a partial list.

**Attribute friction to systems, not people.** "Reviews on the payments module average three revisions and four days" is useful to an architect. "Sam keeps needing rework" is not, and it makes the digest something the user cannot share. Name people for authorship and for who to talk to, not as the cause of a problem.

**Bots are excluded by default** from pulling a thread into the results, but their events still show on threads included for other reasons. Pass `--include-bots` if the user is specifically asking about CI or automation.

## What a good digest looks like

Lead with the two or three things that would change the reader's plans. Then the substance, organized by theme rather than by repository — a cross-cutting argument that touched three repos is one story, not three.

For each item worth reporting: what changed, what was contested and how it resolved, who was involved, and the thread reference. Where you notice something recurring — the same subsystem fought three times, reviews stalling in one area — say so plainly and show the evidence. Do not manufacture a theme to have one; if the window was quiet, a short digest is the honest answer.

## Setup

Chyme reads `~/.config/chyme/config.json`. If a command reports no projects configured:

```bash
chyme project add <slug> --name "<name>"
chyme source add <owner/repo> --project <slug>
```

Then add a GitHub token to the config under `credentials.github.token` — the value supports `${GITHUB_TOKEN}`, so it can point at an environment variable rather than sitting on disk. Only `sync` needs it; every read command works without one.

## Command reference

| Command | Purpose |
| --- | --- |
| `chyme sync [-p <slug>] [--full] [-s <when>] [-q]` | Pull new and changed threads. `--full` re-reads everything; `--since` reaches back past the stored watermark. |
| `chyme activity [-s <when>] [-u <when>]` | Index of what moved. Filters: `-a/--author`, `-r/--repo`, `--path`, `-k/--kind`, `--include-bots`. |
| `chyme thread <ref>` | Expand one thread. `-d/--diff`, `--no-comments`, `--no-commits`. |
| `chyme search <words...>` | Keyword search. `-s/--since`, `-n/--limit`. |
| `chyme digest save -w <since>..<until>` | Store a composed digest from stdin or `--file`. `-s/--since` with an optional `-u/--until` also works, but `--window` is what keeps the saved window exactly the one you read. |
| `chyme digest list \| show <id>` | Re-read saved digests. `list` shows a page and says how many there are. |
| `chyme project add \| list \| remove` | Manage projects. |
| `chyme source add \| list \| remove` | Manage a project's sources. |

Every read command takes `--max-bytes` to cap its output, and `--project` when more than one project is configured.

`<when>` accepts `last`, a relative offset (`7d`, `36h`, `2w`), a date (`2026-07-01`), or an ISO 8601 timestamp. Windows are half-open: `[since, until)`.
