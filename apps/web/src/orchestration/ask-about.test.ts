import type { FinishedWorker, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { aboutFinishedWorker } from "./ask-about";

describe("Ask about it", () => {
  it("opens a message with the worker's reference, feature, PRs and last report", () => {
    const worker: FinishedWorker = {
      threadId: "t-dl" as ThreadId,
      workspaceId: "w1" as WorkspaceId,
      title: "Dead-letter table",
      feature: "mail-retry-policy",
      closedAt: 0,
      completedReason: "prMerged",
      lastReport: {
        threadId: "t-dl" as ThreadId,
        state: "done",
        summary: "The table is in.",
        at: 0,
      },
      prs: [{ repo: "example/api", number: 428, url: "https://x", merged: true }],
      kept: "closed",
    };
    expect(aboutFinishedWorker(worker)).toBe(
      'About the finished worker "Dead-letter table" [thread t-dl] in mail-retry-policy, merged as example/api#428. Its last report: "The table is in."\n\n',
    );
    const { lastReport: _report, ...bare } = worker;
    expect(aboutFinishedWorker({ ...bare, prs: [] })).toBe(
      'About the finished worker "Dead-letter table" [thread t-dl] in mail-retry-policy.\n\n',
    );
  });
});
