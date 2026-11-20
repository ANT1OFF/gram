import type { Thread } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { threadData } from "./thread-data.ts";

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
