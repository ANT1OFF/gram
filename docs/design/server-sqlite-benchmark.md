# Server SQLite benchmark

This investigation measures the shipped storage and orchestration paths before changing them.
The results and ranked recommendations will follow the five large-fixture repeats. No runtime,
schema or dependency change is part of the harness.

## Threading today

The pinned `@effect/sql-sqlite-node` implementation in this checkout uses synchronous
`node:sqlite`, with a cache of prepared statements. Effect fibers share the server's JavaScript
thread: concurrent fibers do not move a native SQLite call, JSON decoding or ledger assembly to
another OS thread. Those operations compete with agent event processing and feed publication.

The server has one application database connection. WAL checkpoints use a separate connection
in a worker thread, with a bounded fallback to SQLite's automatic checkpoints on the application
thread. The existing page cache, mmap and NORMAL-sync settings already apply. The in-flight
durable-commit work in PRs #202 and #204 remains outside this investigation's edits.

See [storage](../../packages/server/src/persistence/thread-store.ts),
[checkpointing](../../packages/server/src/persistence/wal-checkpointer.ts), and
[ledger assembly](../../packages/server/src/orchestration/service/ledger-watch.ts).

## Reproduction

Use the pinned dependencies, with no other benchmark or full check running. The command runs
five repeats serially and writes its raw measurements to a temporary JSON file:

```sh
GRAM_PERF_SQLITE=1 GRAM_PERF_SQLITE_OUT=/tmp/gram-perf-sqlite.json \
  node node_modules/vitest/vitest.mjs run packages/server/src/perf/sqlite.perf.test.ts --maxWorkers=1
```

`GRAM_PERF_SQLITE_SMOKE=1` reduces history to 2,000 messages and 100 reports for functional
validation. Its output explicitly records `smoke: true`; it is not performance evidence for
the large dataset. The suite is skipped by default.

The [fixture](../../packages/server/src/perf/sqlite-fixture.ts) generates 10 workspaces, 300
threads, 200,000 messages, 100,000 reports, 100,000 orchestration events, 290 bound PR references
and 600 scheduled wakes. Half the messages belong to a long-lived orchestrator; the rest span
the other threads. Assistant messages contain text and 1 KiB of synthetic tool output. Seeding
keeps the production search and usage triggers enabled. All providers and GitHub reads are
explicit fakes from the orchestration test harness; no live accounts or source database are
used. Workspaces are paused to keep background orchestration from starting new work.

Each repeat copies the same checkpointed fixture, constructs fresh services and connections,
and runs three fake-agent turns through the real runtime while measuring:

- Event-loop delay at 1 ms resolution: p50, p99 and maximum.
- Feed resume and window, cached and invalidated thread lists, ledger assembly, compact worker
  formatting, digest input reads and diffing, common and scoped search, one-day usage and a
  deliberately expensive full orchestrator transcript read.
- Native statement durations, statement counts, message upserts per emitted chunk, DML
  statements per transaction and changed rows including trigger effects.
- Sampled WAL file size and worker-reported checkpoint time and frame counts.
- Core service construction time and host load at the start of each repeat.
- `EXPLAIN QUERY PLAN` for executed reads, with bindings used only in memory.

## Interpretation limits

File resets are repeatable logical state, not a cold OS page cache. Service startup excludes
module loading, HTTP listening, renderer connection and live-provider startup. Digest timing
excludes memory-file reads, cost persistence, claiming and delivery. Fake-agent event processing
exercises storage and in-process feed publication; websocket fan-out and real stdio transport
need separate qualification. The full transcript probe is a deliberate stress case, not a claim
that a normal feed reads the whole history.

The statement probe wraps `StatementSync.all` in the isolated test process, where the pinned
Effect adapter executes ordinary reads and writes, and restores it on scope exit. Native timing
excludes Effect scheduling and decoding; service timing includes them and can include
interleaved streaming work. Transaction size counts application DML statements, not SQLite
pages; changed-row totals also include FTS and other triggers. WAL file size is allocated space,
not the number of outstanding frames: use checkpoint reports to interpret it. Sampled size is
a lower bound on the physical peak. Idle/full-check contention must be reported with any numbers.

## Candidate next steps, pending measurements

Check query plans and native calls above approximately 5 ms before proposing indexes or SQL
rewrites. Check the ledger's per-worker reads against its service time before adding batching
or derived-state caches. Count streaming saves before changing their batching policy: the
runtime already coalesces writes and defers search indexing.

A reader worker is a structural option only if expensive reads remain after contained fixes.
Its design would preserve one writer, use a separate WAL reader connection, define snapshot
freshness and cancellation, bound returned payloads, and keep transaction-dependent reads on
their owning connection. Moving SQL alone would still leave decoding and serialization on the
server thread unless those are also measured and assigned deliberately.
