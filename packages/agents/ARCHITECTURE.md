# Agent package architecture

[Up: Gram architecture](../../docs/ARCHITECTURE.md) · [Agent permissions](../../docs/AGENTS_AND_FEATURES.md)

Adapters run the developer's installed Claude Code/Codex CLIs with their own
logins; explicitly configured gateways remain optional. Codex and Claude Code are the only executable harnesses.
Shared utilities discover and execute CLIs without choosing authentication.
This page owns package implementation navigation; permission/support qualification
belongs to the linked product guide.

## Internal owners

| Owner                                 | Responsibility                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CLI discovery](src/cli/discovery.ts) | Login-shell probe parsing, PATH candidates, executable classification and bounded reads                                                                 |
| [CLI process](src/cli/process.ts)     | Command execution, Windows batch invocation, nonzero results, interruption/timeouts                                                                     |
| [CLI cache](src/cli/cache.ts)         | Serialized success-only discovery cache; failure remains retryable and reset waits for an active read                                                   |
| [Claude binary](src/claude/binary.ts) | SDK shim/version/auth classification; public exports and Claude-not-found semantics                                                                     |
| [Claude usage](src/claude/usage.ts)   | Request deduplication, token/context windows, model variants, learned rates and restored/reset costs                                                    |
| Adapter sessions and shared servers   | Provider protocol, approvals, event ordering/cancel, child/routing ownership and retention; authentication environment filtering stays adapter-specific |

Do not merge resource owners merely because counters look alike. Codex retention
also covers RPC routing, managed holds and generated gateway files. Preserve held
siblings, last-release shutdown, replacement-child identity and startup-failure
cleanup. The [Codex thread fence](src/codex/thread-ownership.ts) requires observed
owning-child exit, including for cached-child reopen; listeners/unsubscribe or
`thread/closed` are insufficient writer-release proof. This is distinct from the
shared child-retirement lease.

## Fixtures

[Offline scenario guidance](scripts/scenarios/README.md) owns generation commands,
consumer relationships and invented replay semantics. Production child-protocol
fixtures cover discovery/consent/approval/cancel/resume without paid accounts.
Generated Codex bindings have their own version qualification; regeneration is
not verification.

Native thread-writer closure, future CLI
versions, live-provider/Windows behavior and exhaustive security remain separate
qualification as listed in [public readiness](../../docs/PUBLIC_RELEASE.md).
