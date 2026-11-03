import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WakeCondition, wakeConditionLabel, wakeConditionWhen } from "./wake-conditions.ts";

const decode = Schema.decodeUnknownSync(WakeCondition);

describe("wake condition words", () => {
  it("says what a stuck-CI wake waits for, and labels its chip", () => {
    const pr = decode({ kind: "ciStuck", repo: "acme/app", pr: 7 });
    expect(wakeConditionWhen(pr)).toBe(
      "a CI job of acme/app#7 sits queued 15+ min, or a run awaits approval",
    );
    expect(wakeConditionLabel(pr)).toBe("CI job queued 15+ min");
    const run = decode({ kind: "ciStuck", repo: "acme/app", runId: 55, queuedMinutes: 30 });
    expect(wakeConditionWhen(run)).toBe(
      "a CI job of acme/app run 55 sits queued 30+ min, or a run awaits approval",
    );
    expect(wakeConditionLabel(run)).toBe("CI job queued 30+ min");
  });

  it("says what a machine wake waits for, and labels its chip", () => {
    const load = decode({ kind: "machine", metric: "load", below: 8 });
    expect(wakeConditionWhen(load)).toBe("this machine's load stays below 8 for 5 min");
    expect(wakeConditionLabel(load)).toBe("quieter (load < 8)");
    const disk = decode({
      kind: "machine",
      metric: "diskFree",
      belowGB: 20,
      path: "/Users/me/code",
    });
    expect(wakeConditionWhen(disk)).toBe("free disk space at /Users/me/code drops below 20 GB");
    expect(wakeConditionLabel(disk)).toBe("disk < 20 GB");
  });

  it("decodes neither a metric it doesn't know nor a metric's fields under the other", () => {
    expect(() => decode({ kind: "machine", metric: "memory", below: 1 })).toThrow();
    expect(() => decode({ kind: "machine", metric: "diskFree", below: 20 })).toThrow();
    expect(() =>
      decode({ kind: "machine", metric: "load", below: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });
});
