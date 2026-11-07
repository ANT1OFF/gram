import { StatementSync, type SQLInputValue } from "node:sqlite";

export const spread = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) =>
    Number((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(3));
  return { p50: at(0.5), p99: at(0.99), max: at(1), min: at(0), n: values.length };
};

interface Call {
  sql: string;
  bindings: SQLInputValue[];
  ms: number;
}

/** Test-process-only instrumentation; captures no expanded SQL or result values. */
export const sqliteProbe = () => {
  const original = StatementSync.prototype.all;
  let calls: Call[] | undefined;
  StatementSync.prototype.all = function (...bindings) {
    const start = performance.now();
    try {
      return original.apply(this, bindings);
    } finally {
      calls?.push({
        sql: this.sourceSQL,
        bindings: bindings as SQLInputValue[],
        ms: performance.now() - start,
      });
    }
  };
  return {
    start: () => {
      calls = [];
    },
    stop: () => {
      const captured = calls ?? [];
      calls = undefined;
      const statements = new Map<string, number[]>();
      const transactions: number[] = [];
      let size = 0;
      for (const call of captured) {
        const times = statements.get(call.sql) ?? [];
        times.push(call.ms);
        statements.set(call.sql, times);
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(call.sql)) size++;
        if (/^\s*COMMIT/i.test(call.sql)) {
          transactions.push(size);
          size = 0;
        }
      }
      return {
        calls: captured,
        summary: {
          nativeMs: captured.reduce((n, call) => n + call.ms, 0),
          statements: captured.length,
          writes: captured.filter((call) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(call.sql))
            .length,
          transactionDmlStatements: spread(transactions),
          messageUpserts: captured.filter((call) => /^\s*INSERT INTO messages\b/i.test(call.sql))
            .length,
          byStatement: [...statements]
            .map(([sql, times]) => ({ sql, ...spread(times) }))
            .toSorted((a, b) => b.max - a.max),
        },
      };
    },
    restore: () => {
      StatementSync.prototype.all = original;
    },
  };
};
