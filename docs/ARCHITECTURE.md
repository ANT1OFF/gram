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

Workspace dependencies and build references are explicit in manifests/tsconfigs,
and `no-restricted-imports` in `.oxlintrc.json` holds source to the same graph:
web and contracts/themes import no Node or Electron, only the shell imports
Electron at runtime, and no package imports an app. In the desktop, the preload
(`apps/desktop/src/preload`) brings in values only from `electron` and the shell's
preload-safe entries, because a sandboxed preload can load nothing else; the main
process never imports the web app or agent code, and takes only the server's light
entries (`logging`, `updates`, `host/launch-args`), because the server runs as its
own process. `gram/no-cross-package-path` refuses a relative path from one package's
sources into another, which would skip all of the above.
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
- [Memory updates](../packages/server/src/orchestration/dreams.ts) own candidate/review/adoption and file-commit
  freshness, drain and recovery. Their capability is separate from ordinary sessions
  and [helper consent](AGENTS_AND_FEATURES.md#ai-helpers-and-context-consent).
- [Docs](../packages/server/src/docs/docs.ts) owns a workspace's published docs (`publish_doc`,
  `read_doc`, `archive_doc`, `delete_doc`, the Docs tab): one `<id>.doc` record each (a metadata
  line, then the Markdown) under `<dataDir>/docs/<workspaceId>/`, never in a repo and never
  uploaded. An archived doc moves to `archive/` beside them, with `archivedAt` and a reason; the
  200-doc cap counts active docs only, and the archive keeps 2,000, purging the earliest archived
  first. Only an archived doc can be deleted, by the orchestrator or the user. Each save keeps the
  version it replaces in `history/<id>/<revision>.doc`, the last 10. A doc may be bound to a PR
  (`pr`: the author's bound PR, or one a reviewer names). A workspace keeps one active doc per
  PR, which any of its threads may update, so review rounds fold into it. [The docs sweep](../packages/server/src/docs/docs-sweep.ts),
  on the worktree sweep's timer, archives a PR's doc some days after its PR merges or closes and a
  worker's other docs some days after it is archived (Settings, Storage), never the orchestrator's
  or one the user opened or saved in the last 14 days. A save is one rename, so a
  failed write leaves the last doc whole and a read always pairs text with its revision. Ids are
  slugs, so every path is a few checked segments; [the file layer](../packages/server/src/docs/doc-files.ts)
  pins every folder from the docs root down by identity for each operation and refuses a link in
  any. Every metadata field is bounded, and each save moves a revision on so the user's edit
  and an agent's update can't overwrite each other.
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
- Input reaches a running thread in one of three ways. **Steer**, the default for everyone, lands
  once the tool calls under way finish and cancels nothing: Claude takes it at priority `next`,
  folded in between tool rounds or run as the turn after, in the same logical turn
  ([Claude session](../packages/agents/src/claude/session.ts)). **Queue** waits for the turn to
  end. **Interrupt** stops the turn now (priority `now`), cutting off its tool calls, which Claude
  Code answers with "The user doesn't want…"; Gram adds that nobody declined them, and the
  transcript shows them as interrupted. Only the user and `send_message`'s `mode: "interrupt"`
  ask for it.
- What steers by default: the composer (↵ steers, ⌥↵ queues, ⌘. with a draft interrupts, and the
  chevron beside Send lists them; the sent message says "Steered" or "Interrupted the turn"), a
  new task to a running orchestrator, `send_message`, `broadcast_message` and
  `message_orchestrator`, answers to questions, and every Gram notice (`sendNotice`: merges,
  checks, reviews, comments, wakes, resumes). `sendNotice`'s `steer: false` queues one instead.
  Digests steer too (`SystemDelivery.steer`), and settle as the turn that carries them ends; one
  whose turn errs waits again. Idle compaction and a handoff's checkpoint stay turns of their
  own. A steer falls back to an ordinary send, which queues behind a turn that can't take it:
  one waiting on an approval or an answer (the agent would read it first; `thread.steer` refuses
  it), one starting, Gram's idle compaction, or an agent that refused the steer, which recorded
  nothing, so nothing is delivered twice.
- A Codex steer joins the running turn or fails; it never starts a new turn, cancels nothing, and
  the runtime keeps an input the agent refused. Codex has no interrupting steer, so an interrupt
  reaches it as a steer ([Codex session](../packages/agents/src/codex/session.ts)).

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

The renderer is sandboxed and context-isolated, with no Node integration and DevTools only
in development. The local HTTP server listens on loopback and uses per-launch
boot-token/cookie authentication with Host and Origin checks;
see [HTTP auth](../packages/server/src/http/auth.ts). Desktop IPC and app tools
validate requests again at their authoritative owner. Browser document/access
freshness, helper scope/provider consent, agent approval, worker ownership and
exact-head PR CI are independent checks. A UI disable or cached observation does
not replace them.

Gram reads no Claude Code login token and calls no Anthropic API itself; the palette only
opens claude.ai/code. Agents fetch the web through their own native tools.

Phone access over Tailscale is opt-in; see [remote access](REMOTE_ACCESS.md). Gram has no
telemetry, analytics or crash reporting.

See [contributing](../CONTRIBUTING.md) for review/integration rules,
[verification](VERIFICATION.md) for test limits and [releasing](RELEASING.md) for distribution.
