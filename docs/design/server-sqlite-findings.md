# Server SQLite findings: post-release baseline

Five serial repeats ran on 2026-11-07 after the 1.10.0 release freeze lifted. The earlier
release-overlapping run is excluded. These are a baseline, not before/after improvement claims.
This baseline was captured before production query changes.

The follow-up [contained query changes](server-sqlite-query-wins.md) records the implementation,
isolated feed improvement and the remaining final timing qualification.

The [methodology and threading model](server-sqlite-benchmark.md) describe the synthetic fixture,
command and exclusions. This run used Node v26.12.0, 18 CPUs and main through `2ba625aa`, with
the benchmark harness and native-call forwarding type fix. The database was 299.3 MiB;
generation took 26.5 s. One-minute host load at repeat starts ranged from 13.88 to 14.68.
Raw output remains in `/tmp/gram-perf-sqlite-quiet.json` on the benchmark machine.
The figures below describe that revision. The follow-up records a refreshed baseline that
includes PRs #202 and #214 before comparing query changes.

## Five-repeat service timings

All values are milliseconds; min/median/max describe the five independent repeats.

| Operation                                                   | Minimum | Median | Maximum |
| ----------------------------------------------------------- | ------: | -----: | ------: |
| Core service construction                                   |  174.88 | 243.66 |  675.69 |
| Feed resume: ten changed messages in 100,000-message thread |   33.22 |  39.78 |   75.79 |
| Feed window: 20 turns                                       |    0.37 |   0.58 |    1.11 |
| Cached thread list                                          |   0.010 |  0.012 |   0.047 |
| Invalidated thread list: 303 threads                        |    2.09 |   2.86 |    3.37 |
| Ledger: 29 workers, 100,000 historical reports              |   12.95 |  16.27 |  164.35 |
| Compact worker formatting after ledger read                 |   0.047 |  0.055 |   0.324 |
| Digest input reads and diff                                 |    6.25 |   9.69 |   13.28 |
| Common-term search: 200,000 messages                        |  230.57 | 245.06 |  305.48 |
| Scoped search: 100,000-message orchestrator                 |   74.32 |  83.27 |   90.48 |
| One-day usage                                               |  223.47 | 243.05 |  304.44 |
| Full 100,000-message orchestrator transcript                |  319.21 | 381.78 |  500.32 |

The loop histogram's p50 ranged from 1.296–1.306 ms, p99 from 1.928–2.712 ms, and maximum
from 549.45–638.06 ms. Its low p99 hides infrequent long stalls. The mixed workload issues several
expensive reads close together; maximum lag is not the duration of one individual query.

## Ranked contained improvements

1. **Fix selective feed resume's query plan first.** Its count uses `messages_thread_rev`, but
   the body read chooses `messages_thread_seq` to satisfy ordering and walks old history to find
   ten changed rows. That single native call took 32.48–75.24 ms. Test an existing-index seek
   followed by sorting the small changed set; no new schema or reader thread should be needed.
2. **Make search use FTS ranking efficiently.** Both searches show `USE TEMP B-TREE FOR ORDER BY`
   for `ORDER BY bm25(...)`. Native common-term search took 229.74–303.00 ms; scoped search took
   73.79–89.67 ms. Investigate FTS's ordered rank path while preserving the exact weights,
   filtering, snippets, limits and result behavior. The numbers must justify the final SQL.
3. **Avoid whole-history reads on narrow actions.** The full transcript's native row fetch took
   126.70–295.97 ms, followed by decoding and assembly on the server thread. Current callers include
   attachment previews, tool-image capture and a resume fallback's existence check. The normal
   feed window is already bounded and fast. Profile targeted replacements against those callers'
   behavior and authorization rules before adding an attachment lookup or existence API.
4. **Investigate usage separately before moving it off-loop.** The main native usage query took
   127.05–181.23 ms; service time also includes attribution and aggregation. Plans already use
   `turns_started` and `messages_turn`. The query materializes intermediate sets and groups
   attribution; a generic new index is not demonstrated. A reader worker would need a design
   covering decode/aggregation placement, snapshot freshness, bounded payloads and cancellation.
5. **Batch ledger facts if their remaining cost warrants it.** The two ledger surveys in the
   workload perform 58 latest-turn reads, 58 completion reads and 58 plan reads, plus per-worker
   request and usage reads. Individual repeated worker-fact reads took at most 1.12 ms in this run. Latest reports
   already seek the ordinary and partial interface indexes, avoiding historical scans. Avoid a
   broad derived-state cache until the measured benefit pays for its invalidation paths.

## Writes, transactions and WAL

Each repeat processed 312 emitted chunks across three turns and made 12 message upserts:
0.0385 upserts per chunk. The workload made 44 top-level DML statements, 539 total statements
and 341 changed rows including trigger effects. Its 15 transactions had a median of three and
maximum of four application DML statements. Streaming is already coalesced; per-event storage
batching is not the first demonstrated missing optimization. Small synthetic text replies do
not qualify large growing-message stringify cost.

Allocated WAL space was 799,312 bytes before the timed window and 1,100,072 bytes afterward in
all five repeats. Sampled intermediate size reached 840,512 bytes; file allocation is not the
outstanding frame count. The worker fully checkpointed reported batches of 204 frames and the
267-frame shutdown batch, with no error or fallback event. Periodic checkpoints took
0.032–3.255 ms; final checkpoints took 2.985–7.949 ms. Across 75 timed commits, the largest native
commit was 8.988 ms; this run cannot attribute that outlier to checkpointing or other host activity.

## Scope before a structural change

One application writer connection and the existing checkpoint worker remain the model.
Prepared statements and decoded thread lists are already cached. Ledger reads use
`survey(..., false)` and do not rewrite the outbox; digest cost persistence is a separate path.
The old architecture review's blanket read-path outbox-write claim does not describe this ledger.

Core service construction is not process boot to an authenticated HTTP-ready server. Digest
input/diff timing is not full digest delivery. Websocket fan-out, real stdio transport and
live-provider startup remain unqualified. A reader worker is a later option after contained SQL
and bounded-read changes; structural changes still need a design note and independent review before merge.
