# Contained SQLite query changes

The [ranked baseline](server-sqlite-findings.md) identified synchronous reads as the first
targets. These changes retain the one application writer, its transactions and durable
connection owner, and the WAL checkpoint worker. They add no migration or cache invalidation.

## Query plans

Feed resume already counts its changed set against the response limit. Its body query now
seeks `messages_thread_rev`, then sorts that bounded result into transcript order. The old
planner choice used `messages_thread_seq` to avoid sorting and walked old history to return
ten changed messages. A regression checks the actual executed query's plan, out-of-order
revisions, the optional starting message, missing cursors and the response limit.

Global search consumes FTS5's ordered `rank` with a per-query BM25 mapping that preserves
the existing weights. This removes the external sort before LIMIT. SQLite documents the
[equivalent weighted rank mapping](https://www.sqlite.org/fts5.html#sorting_by_auxiliary_function_results).
Tests compare the old query's results, snippets, equal-score rows and truncation across scopes
and limits, and check plans from the actual production queries.

Scoped searches retain their original filter-then-sort SQL. A five-repeat small-worker probe
caught the reason: using global ordered rank for a scope increased its median from 58.00 to
100.57 ms, despite somewhat lower host load in that trial. The thread-id FTS column is
unindexed, so global ranking does work before filtering to the worker. The plan regression
requires ordered rank globally and the scoped filter-then-sort path. The rejected variant is
not shipped.

## Final interleaved comparison

On 2026-11-07, five default 200,000-message repeats on each side ran in the order
main 1, PR 1, main 2, PR 2, through main 5, PR 5. The Mac continued its normal concurrent
worker load; this is a loaded comparison, not an idle-machine result.

Control was main at `099c11b3`; candidate was the same main with reviewed PR head `f4b2cba2`
merged in a temporary checkout. This includes the usage-history work on both sides.
The two candidate SQL files were checked byte for byte against the reviewed PR files.
The PR branch was not rebased and its code was not changed.
Both sides used Node v26.12.0, 18 CPUs, identical 313,884,672-byte synthetic baseline databases,
`--maxWorkers=1 --pool=threads`, with smoke and optional scope probes disabled.

An external coordinator gated the existing baseline-file copy between repeats, after the
previous service scope closed and before the next load/boot timers started. This preserved
each revision's unedited five-repeat benchmark loop and seeded its fixture once. Only one
repeat executed at a time. Waiting at the gate is excluded from measured service times and
loop histograms. No benchmark or product source was edited to add the gate.

Each cell is **minimum / median / maximum milliseconds**, five repeats per side:

| Operation                       | Main                         | PR                           |
| ------------------------------- | ---------------------------- | ---------------------------- |
| Feed resume                     | 47.405 / 74.974 / 120.280    | 0.329 / 0.609 / 1.129        |
| Global common-term search       | 280.905 / 353.198 / 411.009  | 138.786 / 164.958 / 226.159  |
| Scoped orchestrator search      | 90.550 / 99.585 / 103.371    | 109.331 / 158.917 / 492.497  |
| Feed window                     | 0.430 / 0.832 / 2.878        | 0.301 / 0.445 / 1.098        |
| Cached thread list              | 0.014 / 0.023 / 0.041        | 0.013 / 0.013 / 0.057        |
| Invalidated thread list         | 2.856 / 3.485 / 7.014        | 2.879 / 3.744 / 5.113        |
| Ledger, 29 workers              | 23.413 / 32.140 / 65.676     | 17.552 / 31.655 / 38.327     |
| Compact worker formatting       | 0.044 / 0.056 / 0.178        | 0.045 / 0.051 / 0.217        |
| Digest inputs and diff          | 9.155 / 14.865 / 30.477      | 8.640 / 12.047 / 17.325      |
| One-day usage                   | 286.351 / 427.648 / 437.924  | 226.729 / 305.703 / 653.902  |
| Full 100,000-message transcript | 387.313 / 742.351 / 959.247  | 406.757 / 491.892 / 656.537  |
| Core service construction       | 303.879 / 666.061 / 1661.756 | 503.619 / 778.103 / 1411.442 |

Feed resume improved in every pair: the median paired ratio was 109.7 times
(main/PR), with individual ratios 44.6–302.9 times. Global search also improved in every pair,
with a median paired ratio of 2.14 times.

Scoped-search timings were higher on the PR despite retaining its original SQL and plan.
The cause is not isolated; preceding global-query cache effects and host activity may contribute.
That result is retained above rather than treated as an improvement. Usage, full-history reads
and loop maxima remain substantial; these changes do not establish an overall loop-lag gain.
Across repeats, loop p50 ranged 1.307–1.348 ms on main and 1.314–1.329 ms on the PR;
p99 ranged 2.249–4.719 ms and 2.281–3.596 ms; maxima ranged 725.615–973.603 ms and
547.881–1,298.137 ms respectively.

### Recorded host load

Tuples are the harness's **1 / 5 / 15 minute load averages**, captured at each repeat's start:

| Repeat pair | Main load             | PR load               |
| ----------- | --------------------- | --------------------- |
| 1           | 29.51 / 27.81 / 24.49 | 33.87 / 28.74 / 24.84 |
| 2           | 32.28 / 28.50 / 24.77 | 32.34 / 28.57 / 24.82 |
| 3           | 31.59 / 28.48 / 24.81 | 30.98 / 28.40 / 24.81 |
| 4           | 28.86 / 28.04 / 24.72 | 27.59 / 27.79 / 24.65 |
| 5           | 26.42 / 27.55 / 24.58 | 28.23 / 27.90 / 24.73 |

Each side emitted 312 chunks, made 12 message upserts, 44 application DML statements,
539 total statements and 341 changed rows including triggers per repeat. Transactions held a
median of three and maximum of four application DML statements. Allocated WAL space grew
807,552 → 1,100,072 bytes on both sides. All reported checkpoint batches completed; periodic
checkpoint durations were 0.030–7.375 ms on main and 0.046–3.996 ms on the PR. Shutdown
checkpoints were 4.192–91.425 ms and 2.327–16.775 ms respectively. No checkpoint error or
fallback event was reported; the physical WAL allocation is not outstanding frames.

The earlier isolated low-load feed comparison also improved 58.901 → 0.586 ms at the median.
Earlier unpaired batches are not used for the final paired ratios above. Raw final results on
the benchmark machine are `/tmp/gram-perf-sqlite-paired-main.json`,
`/tmp/gram-perf-sqlite-paired-pr.json` and `/tmp/gram-perf-sqlite-paired-metadata.json`.

## Reproduction and verification

Use the [benchmark command](server-sqlite-benchmark.md#reproduction). Add
`GRAM_PERF_SQLITE_SCOPES=1` for the small-worker scope diagnostic; the output records
`scopeProbe: true`. That optional query is excluded from the default comparison above.

Both plan regressions failed on the original queries and pass with the corresponding changes.
The focused search, read-path and feed-resume suites pass 26 tests. Server types, lint,
formatting and scaffold checks pass. Independent review in thread `e73489e5` found head
`f4b2cba2` sound, verified tie order at 300,000 rows, and confirmed the failing/passing plan
regressions. The user lifted the review hold. Subsequent PR changes contain docs/numbers only.
The full integration gate remains managed by the armed merge.
The earlier startup/digest/transport measurement exclusions still apply; these SQL changes
do not move reads or JSON work onto a reader thread.
