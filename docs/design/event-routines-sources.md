# Event routines: which events to start on

A routine can start when something happens instead of on a clock. Gram has no webhook and no
public endpoint, so an event is something a poll can see: GitHub through the user's own `gh`, held
to the background share of the allowance (`github/budget.ts`), or state Gram already keeps. This
note surveys the candidates and picks the first set.

How each was judged:

- **Reuse**: an existing poll or source that already reads it.
- **Cost**: extra `gh` calls per poll, against 5,000 core points an hour and about 30 searches a
  minute, shared with everything else on the token.
- **Dedupe**: the key that makes one occurrence. Each routine keeps its delivered keys, so a
  restart neither fires again nor misses what happened while Gram was closed.
- **Trust**: what reaches the brief from outside. PR titles, author logins, workflow names and
  release tags are someone else's text, so they go into the brief fenced as untrusted data
  (`git/untrusted-fence.ts`), never as instructions.
- **Use**: how often a solo developer running Claude Code or Codex would want work started by it.

## Candidates

| Event                                    | Reuse                                           | Extra cost per poll                                             | One occurrence              | Trust                           | Use                                                |
| ---------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | --------------------------- | ------------------------------- | -------------------------------------------------- |
| Review requested from me                 | `ReviewRequestsPoller` (5 min)                  | none: reads its list                                            | repo + PR number            | title, author                   | high                                               |
| A PR in my repo becomes ready for review | `OpenPrs`' GraphQL read, widened                | 1 GraphQL point per repo                                        | repo + PR number            | title, author                   | high                                               |
| Default-branch CI goes red               | `BranchHeads` (default branch)                  | 1 REST call per repo                                            | head commit                 | workflow names                  | high                                               |
| A release upstream or of a dependency    | `UpstreamReleases` + `releasePublished`'s cache | npm or 1 REST, kept 6 h                                         | package + version           | tag, URL                        | medium-high                                        |
| New comment or review on my PR           | own-PR search has `updatedAt` only              | 1+ per PR                                                       | comment id                  | comment body: long, adversarial | medium; PR monitors cover it                       |
| Issue opened or labelled                 | none                                            | 1 REST per repo                                                 | issue number (+ label)      | title, body                     | medium; noisy in busy repos                        |
| Dependabot or security alert             | none                                            | 1 REST per repo; needs `security_events` scope most tokens lack | alert number                | advisory text                   | medium; many tokens can't read it                  |
| A subscription limit resets              | `limit-pause.ts`, held briefs                   | none                                                            | agent + window + reset time | none                            | low-medium: held briefs already start at the reset |
| Installed CLI version changed            | `InstalledVersions`                             | none                                                            | target + version            | none                            | low-medium; overlaps release published             |
| Branch moved                             | `branchMoved` wake                              | 1 REST per repo                                                 | head commit                 | none                            | low as a routine; good as a wake                   |
| A worktree's checks fail                 | check runs are per thread                       | none                                                            | run id                      | log tail                        | low: the thread that ran them already knows        |
| Thread or worker finished or stuck       | `threadFinished`, ledger                        | none                                                            | thread + report             | report text                     | low: the orchestrator already follows its workers  |
| App idle or startup                      | `AppActivity`                                   | none                                                            | day                         | none                            | low: a schedule says it better                     |

## First set

1. **Review requested from me** (`reviewRequested`, optional `repo`). Free: the review-request
   poll already lists them. It needs review requests on in Settings → Notifications, and the
   routine says so while they are off.
2. **A PR becomes ready for review** (`prReady`, in the routine's project). The DeepSeek Harness
   case: opened ready, or moved out of draft. One small GraphQL list per poll, every 10 minutes.
   Bots' PRs are left out unless asked for.
3. **Default-branch CI fails** (`ciFailed`, optional `branch`). The latest commit on the branch
   with a completed run that failed, timed out or couldn't start. One REST call every 10 minutes.
4. **A release is published** (`releasePublished`, `npm` or `github`, `name`, `minAgeDays`).
   Reuses the upstream-release reader; read every 6 hours at most, shared with release wakes. It
   fires once for the newest release past what it last saw, so a burst of patch releases is one
   run.

These four reuse what Gram already polls and cover the cases that most often start work: someone
wants a review, code is ready, the build is red, a dependency moved.

## Deferred, and why

- **Comment or review on my PR**: PR monitors already wake the thread that owns the PR. A routine
  would mostly duplicate that, and comment bodies are the largest untrusted input.
- **Issue opened or labelled**: useful for triage. Next in line, as a label filter on one repo, so
  a busy repo doesn't start a worker per issue.
- **Dependabot and security alerts**: most `gh` tokens can't read them without an added scope, so
  it would fail quietly for most users.
- **Limit reset**: held briefs already start at the reset, and the orchestrator gets a digest
  then. A routine adds little until there's a "do this with the fresh window" case.
- **CLI version changed, branch moved, worktree checks, thread finished, idle or startup**: either
  a wake already covers them for the thread that cares, or a schedule says it better.

## Rules every event routine keeps

- One occurrence is delivered at most once per routine, by its key. The first look after a routine
  is added or turned on only records what's already there; it never fires for it.
- A burst is one run: the events that are waiting when the routine is free go into one brief, at
  most 5 listed, and the rest are counted.
- After a run, a routine waits at least 15 minutes before it fires again. While its last worker is
  live or its brief is held, new events wait.
- Workspace pause, the subscription threshold, the worker cap and the approval rules apply as they
  do to a scheduled run.
