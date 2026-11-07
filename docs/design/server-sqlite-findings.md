# Server SQLite findings: provisional baseline

The first five-repeat run on 2026-11-07 overlapped the 1.10.0 release's full test suite.
These numbers establish candidates, not a quiet baseline or evidence of an improvement.
Heavy work is held until 08:05Z or the main-branch release freeze lifts, whichever comes first;
repeat the same benchmark then before drawing performance conclusions or implementing wins.

The [methodology and threading model](server-sqlite-benchmark.md) describe the generated dataset,
command and exclusions. This run used Node v26.12.0, 18 CPUs, main through `2ba625aa`, the
benchmark harness and its native-call forwarding type fix. The database was 299.3 MiB;
generation took 16.1 s. One-minute host load at repeat starts ranged from 14.45 to 14.90.
The release overlap was reported after the run finished. No production code has changed.

## Five-repeat service timings

All values are milliseconds; min/median/max describe the five independent repeats.

| Operation                                                   | Minimum | Median | Maximum |
| ----------------------------------------------------------- | ------: | -----: | ------: |
| Core service construction                                   |  123.04 | 247.20 |  401.31 |
| Feed resume: ten changed messages in 100,000-message thread |   25.50 |  43.62 |   56.66 |
| Feed window: 20 turns                                       |    0.38 |   0.74 |    1.17 |
| Cached thread list                                          |   0.010 |  0.012 |   0.174 |
| Invalidated thread list: 303 threads                        |    2.02 |   3.02 |    3.39 |
| Ledger: 29 workers, 100,000 historical reports              |   10.96 |  15.74 |   40.54 |
| Compact worker formatting after ledger read                 |   0.039 |  0.055 |   0.253 |
| Digest input reads and diff                                 |    5.65 |   8.35 |   13.54 |
| Common-term search: 200,000 messages                        |  214.99 | 226.20 |  271.07 |
| Scoped search: 100,000-message orchestrator                 |   75.27 |  76.27 |   87.07 |
| One-day usage                                               |  175.90 | 240.34 |  298.23 |
| Full 100,000-message orchestrator transcript                |  318.04 | 326.27 |  359.09 |

The loop histogram's p50 ranged from 1.153–1.166 ms, p99 from 1.715–1.979 ms, and maximum
from 468.98–661.13 ms. Its low p99 hides infrequent long stalls. The mixed workload issues several
expensive reads close together; maximum lag is not the duration of one individual query.

## Ranked candidates for the quiet rerun

1. **Fix selective feed resume's query plan first.** Its count uses `messages_thread_rev`, but
   the body read chooses `messages_thread_seq` to satisfy ordering and walks old history to find
   ten changed rows. That single native call took 24.99–56.04 ms. Test an existing-index seek
   followed by sorting the small changed set; no new schema or reader thread should be needed.
2. **Make search use FTS ranking efficiently.** Both searches show `USE TEMP B-TREE FOR ORDER BY`
   for `ORDER BY bm25(...)`. Native common-term search took 214.29–266.52 ms; scoped search took
   74.71–86.13 ms. Investigate FTS's ordered rank path while preserving the exact weights,
   filtering, snippets, limits and result behavior. The numbers must justify the final SQL.
3. **Avoid whole-history reads on narrow actions.** The full transcript's native row fetch took
   134.03–183.15 ms, followed by decoding and assembly on the server thread. Current callers include
   attachment previews, tool-image capture and a resume fallback's existence check. The normal
   feed window is already bounded and fast. Profile targeted replacements against those callers'
   behavior and authorization rules before adding an attachment lookup or existence API.
4. **Investigate usage separately before moving it off-loop.** The main native usage query took
   96.91–172.32 ms; service time also includes attribution and aggregation. Plans already use
   `turns_started` and `messages_turn`. The query materializes intermediate sets and groups
   attribution; a generic new index is not demonstrated. A reader worker would need a design
   covering decode/aggregation placement, snapshot freshness, bounded payloads and cancellation.
5. **Batch ledger facts if their remaining cost warrants it.** The two ledger surveys in the
   workload perform 58 latest-turn reads, 58 completion reads and 58 plan reads, plus per-worker
   request and usage reads. Single worker reads were below 1 ms in this run. Latest reports
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
0.092–4.296 ms; final checkpoints took 3.241–8.603 ms. Across 75 timed commits, the largest native
commit was 20.239 ms; this run cannot attribute that outlier to checkpointing or release contention.

## Scope before a structural change

One application writer connection and the existing checkpoint worker remain the model.
Prepared statements and decoded thread lists are already cached. Ledger reads use
`survey(..., false)` and do not rewrite the outbox; digest cost persistence is a separate path.
The old architecture review's blanket read-path outbox-write claim does not describe this ledger.

Core service construction is not process boot to an authenticated HTTP-ready server. Digest
input/diff timing is not full digest delivery. Websocket fan-out, real stdio transport and
live-provider startup remain unqualified. A reader worker is a later option after contained SQL
and bounded-read changes; this provisional run does not authorize a threading refactor or merge.
