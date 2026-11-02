import type {
  FeatureCard,
  FeatureCardWorker,
  OrchestratorLedger,
  ProjectId,
  ThreadId,
  WorkerLedgerEntry,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { overviewFeatures } from "./overview-model";
import { boardRows, railRows } from "./rail-model";
import { workerShown, type ShownFacts } from "./worker-shown";
import { ledgerWorkersOver, workerTones } from "./workers-model";

// One rule for whether a worker shows, which the overview sidebar, its orchestrator line's count
// and the Board all go by: the same ledger and cards give the same workers on each.

const ws = "ws-1" as WorkspaceId;
const id = (each: string) => each as ThreadId;

const entry = (
  threadId: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature: "mail-trigger",
  projectId: "p-api" as ProjectId,
  project: "api",
  threadId: id(threadId),
  title: threadId,
  state,
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const cardWorker = (worker: WorkerLedgerEntry): FeatureCardWorker => ({
  threadId: worker.threadId,
  title: worker.title,
  project: worker.project,
  state: worker.state,
  station:
    worker.state === "merged" ? "merged" : worker.state === "inReview" ? "review" : "working",
  now: worker.state,
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
});

/** A worker of each kind the rule tells apart, in the ledger and on one card. */
const workers = [
  entry("working", "working"),
  entry("review", "inReview", { pr: { repo: "o/api", number: 7, state: "open" } }),
  // Reported done with nothing left: Done's.
  entry("reported", "done"),
  // Reported done with its PR still open: it stays.
  entry("reported-pr", "done", { pr: { repo: "o/api", number: 8, state: "open" } }),
  // Merged, with a release run it monitors: something pending.
  entry("merged-run", "merged", {
    runWatches: [{ repo: "o/api", runId: 1, name: "release" } as never],
  }),
  entry("merged", "merged", { pr: { repo: "o/api", number: 9, state: "merged" } }),
  entry("delivered", "delivered"),
  entry("archived", "archived"),
  // Reported done but at work again.
  entry("again", "done"),
  // Reported done, but it asks the user something.
  entry("asking", "done"),
];
const ledger: OrchestratorLedger = {
  features: [{ feature: "mail-trigger", state: "working", workers }],
} as unknown as OrchestratorLedger;
// A worker closed with its worktree: its card keeps it, the ledger has let go.
const closed = cardWorker(entry("closed", "inReview"));
const card: FeatureCard = {
  workspaceId: ws,
  feature: "mail-trigger",
  station: "working",
  version: 1,
  workers: [...workers.map(cardWorker), closed],
  createdAt: 1,
  updatedAt: 1,
};

const running = new Set([id("again")]);
const asking = new Set([id("asking")]);
const over = ledgerWorkersOver(ledger, {});

const SHOWN = ["working", "review", "reported-pr", "merged-run", "again", "asking"];

describe("workerShown", () => {
  const facts: ShownFacts = { running, asking, over };

  it("keeps work going, and a worker done with an open PR or something pending", () => {
    expect(
      card.workers.filter((worker) => workerShown(worker, facts)).map((w) => w.threadId),
    ).toEqual(SHOWN);
  });

  it("lets a worker done with nothing left, archived, or gone from the ledger leave for Done", () => {
    for (const gone of ["reported", "merged", "delivered", "archived", "closed"]) {
      const worker = card.workers.find((each) => each.threadId === gone)!;
      expect(workerShown(worker, facts), gone).toBe(false);
    }
  });

  it("goes by Done's rule: what is over is what Done lists", () => {
    expect([...over].filter(([, done]) => done).map(([threadId]) => threadId)).toEqual([
      "reported",
      "merged",
      "delivered",
      "archived",
      "again",
      "asking",
    ]);
  });

  it("goes by the card before the ledger is read", () => {
    const before: ShownFacts = { running: new Set(), asking: new Set(), over: undefined };
    expect(
      card.workers.filter((worker) => workerShown(worker, before)).map((w) => w.threadId),
    ).toEqual(["working", "review", "closed"]);
  });
});

describe("the sidebar and the Board", () => {
  it("show the same workers from the same ledger and cards", () => {
    const askKeys = new Map([[id("asking"), "ask-1"]]);
    const sidebar = overviewFeatures([card], askKeys, over, [
      { threadId: id("again"), title: "again", feature: "mail-trigger" },
    ]).flatMap((feature) => feature.rows.map((row) => row.threadId));
    const board = boardRows(
      railRows([card], { asking, running, over, status: () => undefined }),
      false,
    ).flatMap((row) => Object.values(row.cells).flatMap((cell) => cell.map((w) => w.threadId)));
    const tally = workerTones(ledger, [...running], { byId: {}, statusDetail: {}, asking });

    expect(new Set(sidebar)).toEqual(new Set(SHOWN));
    expect(new Set(board)).toEqual(new Set(SHOWN));
    // The orchestrator line's "N workers" counts the same.
    expect(tally.live).toBe(SHOWN.length);
  });

  it("let a feature with nothing left to show leave both, the Board's line for Done", () => {
    const finished: FeatureCard = {
      ...card,
      feature: "shipped",
      workers: card.workers.filter((worker) => !SHOWN.includes(worker.threadId)),
    };
    const facts = { asking, running, over, status: () => undefined };
    expect(overviewFeatures([finished], new Map(), over)).toEqual([]);
    expect(boardRows(railRows([finished], facts), false)).toEqual([]);
    // Show finished brings it back.
    expect(boardRows(railRows([finished], facts, "all"), true)).toHaveLength(1);
  });
});
