import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { MockReviews } from "@/api/mock-review";

import {
  addressBlockersMessage,
  addressThreadMessage,
  displayBody,
  groupReviewThreads,
} from "./review-model";

const threads = new MockReviews().review("t-flaky" as ThreadId).threads;
const byId = (id: string) => threads.find((t) => t.id === id)!;

describe("groupReviewThreads", () => {
  it("groups unresolved threads by file, most severe first, outdated and resolved apart", () => {
    const { files, resolved } = groupReviewThreads(threads);
    expect(
      files.map((f) => ({
        path: f.path,
        current: f.current.map((t) => `${t.severity}@${t.line}`),
        outdated: f.outdated.map((t) => t.id),
      })),
    ).toEqual([
      {
        path: "src/retry.test.ts",
        current: ["blocker@13", "suggestion@18"],
        outdated: ["PRRT_sleep_import"],
      },
      { path: "src/retry.ts", current: ["blocker@42", "finding@8"], outdated: [] },
    ]);
    expect(resolved.map((t) => t.id)).toEqual(["PRRT_jitter"]);
  });

  it("puts a file with blockers before one with only findings", () => {
    const { files } = groupReviewThreads([
      { ...byId("PRRT_backoff_name"), path: "a.ts" },
      { ...byId("PRRT_retry_last_error"), path: "z.ts" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["z.ts", "a.ts"]);
  });
});

describe("messages", () => {
  it("strips the tag and suggestion block for display", () => {
    expect(displayBody(byId("PRRT_tick_async").comments[0]!.body)).toBe(
      "Drain pending timers instead of ticking a fixed 100 ms, so the test doesn't depend on the backoff constant.",
    );
  });

  it("builds a structured message for one finding", () => {
    const text = addressThreadMessage(412, byId("PRRT_restore_timers"));
    expect(text).toMatch(
      /^Address review finding on PR #412 — `src\/retry.test.ts:13` \[blocker\]:/,
    );
    expect(text).toContain("> The fake clock is never restored");
    expect(text).toContain("Suggested change:");
    expect(text).toContain("onTestFinished(() => clock.uninstall());");
    expect(text).toContain("reply in the review thread (id `PRRT_restore_timers`)");
  });

  it("lists every blocker in one message", () => {
    const text = addressBlockersMessage(412, [
      byId("PRRT_retry_last_error"),
      byId("PRRT_restore_timers"),
    ]);
    expect(text).toMatch(/^Address all 2 review blockers on PR #412:/);
    expect(text).toContain("1. `src/retry.ts:38-42` [blocker]");
    expect(text).toContain("2. `src/retry.test.ts:13` [blocker]");
  });
});
