import type {
  FeatureCard,
  FeatureLedgerEntry,
  GramUIMessage,
  OrchestrationDigest,
  ThreadId,
  WorkerLedgerEntry,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { digestLineWords, planStream, spawnedFeatures } from "./stream-model";

const W = "w-1" as WorkspaceId;
const A = "t-a" as ThreadId;

const worker = (patch: Partial<WorkerLedgerEntry> = {}): WorkerLedgerEntry => ({
  feature: "mail-trigger",
  projectId: "p" as WorkerLedgerEntry["projectId"],
  project: "api",
  threadId: A,
  title: "Queue worker",
  state: "working",
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...patch,
});

const feature = (name: string, workers = [worker({ feature: name })]): FeatureLedgerEntry => ({
  feature: name,
  state: workers[0]!.state,
  workers,
});

const digest = (generation: number, patch: Partial<OrchestrationDigest> = {}) =>
  ({
    kind: "orchestration",
    variant: "digest",
    generation,
    workspaceId: W,
    workspaceName: "agent-platform",
    reasons: ["wake"],
    changes: [],
    reports: [],
    features: [],
    budget: { liveWorkers: 1, maxConcurrentWorkers: 4, costUsdToday: 0 },
    notes: [],
    ...patch,
  }) satisfies OrchestrationDigest;

const digestMessage = (id: string, at: number, data: OrchestrationDigest): GramUIMessage => ({
  id,
  role: "user",
  metadata: { createdAt: at },
  parts: [
    { type: "text", text: "Orchestration digest" },
    { type: "data-orchestration-digest", data },
  ],
});

const said = (id: string, at: number, role: "user" | "assistant" = "assistant"): GramUIMessage => ({
  id,
  role,
  metadata: { createdAt: at },
  parts: [{ type: "text", text: "Hello" }],
});

const spawning = (id: string, at: number, slug: string): GramUIMessage => ({
  id,
  role: "assistant",
  metadata: { createdAt: at },
  parts: [
    {
      type: "dynamic-tool",
      toolName: "mcp__gram__spawn_worker",
      toolCallId: `call-${id}`,
      state: "output-available",
      input: { feature: slug, title: "Queue worker", brief: "…" },
      output: { threadId: A },
    },
  ],
});

const card = (name: string, updatedAt = 100): FeatureCard => ({
  workspaceId: W,
  feature: name,
  station: "working",
  version: 1,
  workers: [],
  createdAt: 10,
  updatedAt,
});

/** A clock that shows which time it was given. */
const clock = (at: number) => `t${at}`;

/** A digest as `planStream` hands it to its line. */
const entry = (id: string, at: number | undefined, data: OrchestrationDigest) => ({
  message: digestMessage(id, at ?? 0, data),
  digest: data,
  at,
});

describe("the calm stream", () => {
  it("folds digests with nothing between them into one quiet line, on the last of them", () => {
    const messages = [
      said("m1", 1, "user"),
      digestMessage("d1", 2, digest(1, { reasons: ["wake: 30 min"] })),
      digestMessage("d2", 3, digest(2, { reasons: ["stage set"] })),
      said("m2", 4),
    ];
    const plan = planStream(messages, []);
    // d1 has no line or card of its own, so it leaves the stream for d2's line.
    expect(plan.messages.map((message) => message.id)).toEqual(["m1", "d2", "m2"]);
    expect(plan.extras.get("d2")).toMatchObject({ lines: [], cards: [] });
    expect(plan.extras.get("d2")?.digests.map((each) => each.message.id)).toEqual(["d1", "d2"]);
    expect(plan.extras.get("m1")).toBeUndefined();
    expect(plan.extras.get("m2")).toBeUndefined();
    expect(plan.digests.map((each) => each.at)).toEqual([2, 3]);
  });

  it("gives each digest its own line when other messages come between them", () => {
    const messages = [
      digestMessage("d1", 1, digest(1)),
      said("r1", 2),
      digestMessage("d2", 3, digest(2)),
      said("r2", 4),
    ];
    const plan = planStream(messages, []);
    expect(plan.messages.map((message) => message.id)).toEqual(["d1", "r1", "d2", "r2"]);
    expect(plan.extras.get("d1")?.digests.map((each) => each.digest.generation)).toEqual([1]);
    expect(plan.extras.get("d2")?.digests.map((each) => each.digest.generation)).toEqual([2]);
  });

  it("keeps a folded digest that speaks at its place, its line told on the last of the run", () => {
    const features = [feature("rate-headers")];
    const plan = planStream(
      [digestMessage("d1", 1, digest(1, { features })), digestMessage("d2", 2, digest(2))],
      [card("rate-headers")],
    );
    expect(plan.messages.map((message) => message.id)).toEqual(["d1", "d2"]);
    expect(plan.extras.get("d1")).toEqual({ lines: [], cards: ["rate-headers"], digests: [] });
    expect(plan.extras.get("d2")?.digests).toHaveLength(2);
  });

  it("says a digest line in a few words, its reports first, then its changes", () => {
    const report = {
      threadId: A,
      title: "Queue worker",
      feature: "mail-trigger",
      at: 1,
      state: "progress",
      summary: "Halfway.",
    } as const;
    const change = {
      threadId: A,
      feature: "mail-trigger",
      title: "Queue worker",
      from: "working",
      to: "inReview",
    } as const;
    expect(
      digestLineWords([entry("d4", 40, digest(4, { reports: [report, report, report] }))], clock),
    ).toEqual({ title: "Digest #4", count: "3 reports", time: "t40" });
    expect(digestLineWords([entry("d5", 50, digest(5, { changes: [change] }))], clock)).toEqual({
      title: "Digest #5",
      count: "1 change",
      time: "t50",
    });
    expect(digestLineWords([entry("b", undefined, digest(0, { variant: "boot" }))], clock)).toEqual(
      { title: "Session start", count: undefined, time: undefined },
    );
    expect(
      digestLineWords(
        [
          entry("d1", 10, digest(1, { reports: [report] })),
          entry("d2", 20, digest(2, { changes: [change] })),
        ],
        clock,
      ),
    ).toEqual({ title: "2 digests", count: "1 report", time: "t20" });
  });

  it("places each feature's card once, where its worker was spawned, never again", () => {
    const features = [feature("mail-trigger")];
    const messages = [
      said("m1", 1, "user"),
      spawning("s1", 2, "mail-trigger"),
      digestMessage("d1", 3, digest(1, { features })),
      digestMessage("d2", 4, digest(2, { features })),
    ];
    const plan = planStream(messages, [card("mail-trigger")]);
    expect(plan.extras.get("s1")?.cards).toEqual(["mail-trigger"]);
    // Later digests carry the feature but don't repeat its card, and say nothing else: one line.
    expect(plan.messages.map((message) => message.id)).toEqual(["m1", "s1", "d2"]);
    expect(plan.extras.get("d2")?.cards).toEqual([]);
  });

  it("anchors a card at the first digest naming it when its spawn isn't loaded", () => {
    const features = [feature("rate-headers")];
    const plan = planStream(
      [said("m1", 1), digestMessage("d1", 2, digest(1, { features }))],
      [card("rate-headers")],
    );
    expect(plan.extras.get("d1")).toMatchObject({ lines: [], cards: ["rate-headers"] });
    expect(plan.extras.get("d1")?.digests.map((each) => each.message.id)).toEqual(["d1"]);
    expect(plan.messages.map((message) => message.id)).toEqual(["m1", "d1"]);
  });

  it("turns a digest that speaks into lines at its place", () => {
    const merged = worker({
      state: "merged",
      pr: { repo: "acme/api", number: 431, state: "merged", checks: "passing" },
    });
    const plan = planStream(
      [
        digestMessage(
          "d1",
          2,
          digest(1, {
            changes: [
              {
                threadId: A,
                feature: "rate-headers",
                title: "Queue worker",
                from: "readyToMerge",
                to: "merged",
              },
            ],
            features: [feature("rate-headers", [merged])],
          }),
        ),
      ],
      [],
    );
    expect(plan.extras.get("d1")?.lines).toMatchObject([
      { kind: "merged", threadId: A, pr: { number: 431 } },
    ]);
  });

  it("shows a card no loaded message anchors at the top, only while it moved since that page began", () => {
    const messages = [said("m1", 50), said("m2", 60)];
    const plan = planStream(messages, [card("old", 20), card("live", 70)]);
    expect(plan.extras.get("m1")?.cards).toEqual(["live"]);
  });

  it("reads spawn_worker calls by any provider's tool name", () => {
    expect(spawnedFeatures(spawning("s", 1, "paging"))).toEqual(["paging"]);
    expect(spawnedFeatures(said("x", 1))).toEqual([]);
  });
});
