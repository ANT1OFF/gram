import type { Thread } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { errorDetailData, threadData } from "./thread-data.ts";

const thread = (extra: Record<string, unknown> = {}) =>
  ({
    id: "thread-1",
    title: "Fix the docs",
    model: { agent: "claude", model: "opus" },
    parked: false,
    ...extra,
  }) as unknown as Thread;

describe("threadData", () => {
  it("sends why a thread's last turn failed, so a receiver can show it", () => {
    const data = threadData(
      thread({
        lastError: {
          kind: "network",
          retryable: true,
          text: "The machine went away during the turn.",
          at: 7_000,
          machineLost: { machine: "box-1", during: "bun test" },
        },
      }),
    );
    expect(data["lastError"]).toEqual({
      text: "The machine went away during the turn.",
      kind: "network",
      retryable: true,
      at: 7_000,
      machineLost: "box-1",
    });
  });

  it("sends none for a thread whose turns didn't fail, which clears an earlier one", () => {
    expect(threadData(thread())).not.toHaveProperty("lastError");
  });
});

describe("errorDetailData", () => {
  it("sends why a thread is in error, on one line and without a secret in it", () => {
    const data = errorDetailData(
      "error",
      "agent session ended:\n  spawn failed with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(data["detail"]).toMatch(/^agent session ended: spawn failed/);
    expect(data["detail"]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(String(data["detail"])).not.toContain("\n");
  });

  it("sends nothing for a thread that isn't in error", () => {
    expect(errorDetailData("running", "Reading files")).toEqual({});
  });
});
