# Architecture

[Up: Gram](../README.md) · [Agents and features](AGENTS_AND_FEATURES.md)

Gram is a TypeScript monorepo with a React renderer, Electron desktop shell and
local Node server. Effect services/layers own server resources and finalization;
shared schemas define RPC and persisted/wire values. Everything runs on your machine;
no gateway is required. This map points to implementation rather than
copying its API declarations.

## Package boundaries

| Area                                   | Responsibility and source                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [apps/desktop](../apps/desktop)        | Electron entry, build-source capture, server/speech bundles, updates and packaging                |
| [apps/web](../apps/web)                | React routes, conversation/workspace/board UI, API client, mock and real-server browser suites    |
| [contracts](../packages/contracts/src) | Shared schemas, settings, model/support, RPC and shell bridge contracts                           |
| [agents](../packages/agents/src)       | Claude/Codex protocols, authentication classification, discovery and child/session lifecycle      |
| [server](../packages/server/src)       | SQLite persistence, runtime sessions, orchestration, tool authorization, helpers and RPC handlers |
| [git](../packages/git/src)             | Git/worktrees and GitHub PR/check/review operations                                               |
| [shell](../packages/shell/src)         | Electron IPC/native window, terminal, preview, speech and update services                         |
| [themes](../packages/themes)           | Theme definitions and generation                                                                  |
| [tools](../tools)                      | Pin/scaffold checks, test/lint tooling and release scripts                                        |

Workspace dependencies and build references are explicit in manifests/tsconfigs.
Contracts carry shared shape; agent adapters own protocol mechanics; server services
own application state/authorization; shell owns native process/window behavior;
web consumes those interfaces. Keep native Electron imports out of server helpers,
and UI state out of authoritative server decisions. Preserve exact pins/catalog,
native overrides and the Effect patch as described in [development](DEVELOPMENT.md).

See [agent package architecture](../packages/agents/ARCHITECTURE.md) for shared
CLI/session owners and its [offline scenario guidance](../packages/agents/scripts/scenarios/README.md).

## State and lifecycle owners

- [Runtime](../packages/server/src/runtime/thread-runtimes.ts) owns session attachment,
  approvals, turn transitions and recovery. [Persistence](../packages/server/src/persistence)
  owns committed thread state. Listener cleanup is not proof of provider shutdown.
- [Orchestration](../packages/server/src/orchestration) owns charter/task selection,
  membership, startup admission, ledger/outbox, dispatch, holds and dependencies.
  [Agent support](../packages/server/src/agent-support) supplies read-only readiness;
  it cannot grant permissions or substitute a different saved provider/profile.
- [Dream](../packages/server/src/orchestration/dreams.ts) owns candidate/review/adoption and file-commit
  freshness, drain and recovery. Its capability is separate from ordinary sessions
  and [helper consent](AGENTS_AND_FEATURES.md#ai-helpers-and-context-consent).
- [Git publisher](../packages/server/src/git/publisher.ts) owns async watcher and
  completion effects; [PR watch registry](../packages/server/src/git/pr-watches.ts)
  owns synchronous owner indexes/badge deduplication; [keyed lock](../packages/server/src/git/keyed-lock.ts)
  scopes checkout serialization to the operation.
- [Local helper scheduler](../packages/server/src/helper/scheduler.ts) owns consent
  rechecks, concurrency/call limits, redaction, cache invalidation and usage records.
  Gateway credentials remain separately owned by [gateway services](../packages/server/src/gateway).
- [Shell updates](../packages/shell/src/modules/update) and the desktop's
  [update module](../apps/desktop/src/main/update) own release checks, verification of the
  downloaded build and the restart into Squirrel.Mac. See the
  [updater contract](UPDATES.md) for assumptions and recovery limits.
- Background polling that only matters on screen (the port scan, the usage-limit poll) runs
  while a window is shown and slows down while none is focused
  ([`pollWhileShown`](../packages/server/src/git/activity.ts)).
- A Codex steer joins the running turn or fails; it never starts a new turn, and the runtime
  keeps an input the agent refused ([Codex session](../packages/agents/src/codex/session.ts)).

### Database schema

Gram 1.0 starts from one [baseline](../packages/server/src/persistence/migrations.ts) that creates
the whole schema, recorded as migration 1 in `schema_migrations`. There is no upgrade from 0.x: 1.0
keeps its database under a new name, `gram-v1.db`
([database file](../packages/server/src/persistence/database-file.ts)). A 0.x `gram.db` and its
`-wal` and `-shm` files are never opened, moved, locked or deleted; startup only notes, in one log
line, that they are there.

To change the schema in 1.x, append a migration to `migrations` with the next id (`0002_name`)
after merging main. Never edit the baseline or a shipped migration: the loader refuses gaps,
malformed keys, a reused id and an id below the latest applied one. Test it on a database the
baseline made, as [the migration tests](../packages/server/src/persistence/migrations.test.ts) do.

Before splitting a large service, assign its queues, transactions, leases, locks
and finalizers. Move an owner and its invariants together; splitting a closure by
line count alone can hide ordering and cancellation bugs. Use actual-service tests
at the changed boundary.

## Local trust boundaries

The local HTTP server uses boot-token/cookie authentication and origin checks;
see [HTTP auth](../packages/server/src/http/auth.ts). Desktop IPC and app tools
validate requests again at their authoritative owner. Browser document/access
freshness, helper scope/provider consent, agent approval, worker ownership and
exact-head PR CI are independent checks. A UI disable or cached observation does
not replace them.

Gram reads no Claude Code login token and calls no Anthropic API itself; the palette only
opens claude.ai/code. Agents fetch the web through their own native tools.

See [contributing](../CONTRIBUTING.md) for review/integration rules and
[public readiness](PUBLIC_RELEASE.md) for security and distribution limits.
