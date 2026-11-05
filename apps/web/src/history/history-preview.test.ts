import type { FinishedWorker, OrchestratorLedger, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { HistoryEntry } from "./history-model";
import { previewFacts } from "./history-preview";

const workspaceId = "w1" as WorkspaceId;
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  threadId: "t1",
  kind: "worker",
  title: "Release notes for 0.9",
  place: "Gram",
  repo: "docs",
  outcome: "merged",
  agent: "claude",
  archived: false,
  owner: { key: "w1", label: "Gram" },
  workspaceId,
  finishedAt: 20,
  ...over,
});

const ledger = (worker: object): Pick<OrchestratorLedger, "features"> =>
  ({ features: [{ workers: [{ threadId: "t1", ...worker }] }] }) as never;

describe("previewFacts", () => {
  it("reads a worker still on the ledger: its last report, PR, branch and start", () => {
    const facts = previewFacts(entry(), {
      ledger: ledger({
        lastReport: { threadId: "t1", state: "done", summary: "Notes cover undo.", at: 10 },
        pr: { repo: "example/docs", number: 61, state: "merged" },
        branch: "feat/release-notes",
      }),
      finished: undefined,
      startedAt: 5,
    });
    expect(facts).toEqual({
      report: { summary: "Notes cover undo.", at: 10 },
      pr: { number: 61, repo: "example/docs", state: "merged" },
      branch: "feat/release-notes",
      startedAt: 5,
    });
  });

  it("falls back to a closed worker's record, its merged PR first", () => {
    const closed = {
      threadId: "t1" as ThreadId,
      prs: [
        { repo: "example/docs", number: 60, url: "u" },
        { repo: "example/docs", number: 61, url: "u", merged: true },
      ],
      lastReport: { threadId: "t1", state: "done", summary: "  ", at: 10 },
    } as unknown as FinishedWorker;
    const facts = previewFacts(entry(), {
      ledger: undefined,
      finished: [closed],
      startedAt: undefined,
    });
    expect(facts.pr).toEqual({ number: 61, repo: "example/docs", state: "merged" });
    // A blank report says nothing, so none is shown.
    expect(facts.report).toBeUndefined();
  });

  it("gives an imported session its branch and first prompt, unless the title already is it", () => {
    const session = {
      agentSessionId: "s1",
      title: "Speed up the flaky retry suite",
      firstPrompt: "The retry suite times out on CI; find why.",
      updatedAt: 1,
      gitBranch: "fix/retry",
      agent: "claude",
      projectRoot: "/code/api",
    } as const;
    const imported = entry({ outcome: undefined, kind: "imported", session });
    expect(
      previewFacts(imported, { ledger: undefined, finished: undefined, startedAt: 3 }),
    ).toEqual({
      branch: "fix/retry",
      firstPrompt: "The retry suite times out on CI; find why.",
    });
    const same = entry({
      title: session.title,
      outcome: undefined,
      session: { ...session, firstPrompt: session.title },
    });
    expect(
      previewFacts(same, { ledger: undefined, finished: undefined, startedAt: undefined })
        .firstPrompt,
    ).toBeUndefined();
  });
});
