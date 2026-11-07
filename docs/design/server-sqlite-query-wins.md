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

## Five-repeat measurements

The same 200,000-message fixture and default workload ran before changes, with only the feed
change, and with the final query choices. The base contains PRs #202 and #204 and main through
`4c3ef4e1`; the subsequent measurement PR squash changes no production runtime code.
Each cell is **minimum / median / maximum milliseconds**, five repeats per column.

| Operation                         | Before                      | Feed change only            | Final queries               |
| --------------------------------- | --------------------------- | --------------------------- | --------------------------- |
| Feed resume                       | 41.663 / 58.901 / 61.893    | 0.273 / 0.586 / 1.237       | 0.514 / 0.728 / 1.511       |
| Global common-term search         | 206.765 / 219.137 / 253.025 | 239.463 / 243.041 / 275.351 | 118.197 / 139.245 / 164.099 |
| Scoped orchestrator search        | 66.716 / 73.240 / 82.379    | 58.885 / 78.850 / 94.285    | 99.082 / 126.480 / 189.648  |
| Repeat-start one-minute host load | 9.81–10.25                  | 9.83–10.32                  | 20.04–22.81                 |

The isolated feed comparison is about 100 times faster at the median. Global search's observed
times fell despite greater final-batch host load, but this is not a matched-load speedup claim.
The scoped query plan is retained; its higher observed times also need a quieter comparison.
Full-history reads, usage and loop maxima varied substantially with the higher host load.
Final performance qualification remains pending a quieter run; no overall loop-lag improvement
is claimed from these batches.

All default batches emitted 312 chunks, made 12 message upserts and 44 top-level DML statements
per repeat. Streaming saves and transaction structure are retained. Raw outputs on the
benchmark machine are `/tmp/gram-perf-sqlite-before.json`, `/tmp/gram-perf-sqlite-feed.json`
and `/tmp/gram-perf-sqlite-after.json`.

## Reproduction and limits

Use the [benchmark command](server-sqlite-benchmark.md#reproduction). Add
`GRAM_PERF_SQLITE_SCOPES=1` for the small-worker scope diagnostic; the output records
`scopeProbe: true`. That optional query is excluded from the default comparison above.

Both plan regressions failed on the original queries and pass with the corresponding changes.
The focused search, read-path and feed-resume suites pass 26 tests. Server types, lint,
formatting and scaffold checks pass. The full integration gate and independent storage review
remain prerequisites to merging. The earlier startup/digest/transport measurement exclusions
still apply; these SQL changes do not move reads or JSON work onto a reader thread.
