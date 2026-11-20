import { describe, expect, it } from "@effect/vitest";
import {
  keptCheck,
  LOCAL_CHECK_ISOLATION,
  logsOverBudget,
  OTHER_KEEP_MS,
  PASS_KEEP_MS,
  type LocalCheck,
} from "./local-checks.ts";

describe("local check retention", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const record = (status: LocalCheck["status"], age: number): LocalCheck => ({
    head: "a".repeat(40),
    base: "b".repeat(40),
    tree: "c".repeat(40),
    status,
    command: "invented-check",
    isolation: LOCAL_CHECK_ISOLATION,
    startedAt: now - age,
    ...(status === "running" ? {} : { finishedAt: now - age }),
    host: "invented",
  });

  it("keeps running checks, passes for a month and anything else for a week", () => {
    expect(keptCheck(record("running", 365 * DAY), now)).toBe(true);
    expect(keptCheck(record("passed", PASS_KEEP_MS - 1), now)).toBe(true);
    expect(keptCheck(record("passed", PASS_KEEP_MS + 1), now)).toBe(false);
    expect(keptCheck(record("failed", OTHER_KEEP_MS - 1), now)).toBe(true);
    expect(keptCheck(record("failed", OTHER_KEEP_MS + 1), now)).toBe(false);
  });

  it("deletes the oldest finished checks' logs until the rest fit, never a running one's", () => {
    const logs = [
      { key: "running", check: record("running", 9 * DAY), size: 50 },
      { key: "newest", check: record("passed", 1 * DAY), size: 30 },
      { key: "oldest", check: record("failed", 3 * DAY), size: 30 },
      { key: "middle", check: record("passed", 2 * DAY), size: 30 },
    ];
    expect(logsOverBudget(logs, 1000)).toEqual([]);
    expect(logsOverBudget(logs, 100)).toEqual(["oldest", "middle"]);
    // However small the budget, a running check keeps its log.
    expect(logsOverBudget(logs, 0)).toEqual(["oldest", "middle", "newest"]);
  });
});
