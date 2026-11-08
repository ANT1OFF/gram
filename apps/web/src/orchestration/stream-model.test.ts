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

import {
  cardRows,
  digestLineWords,
  planRuns,
  planStream,
  replyPreview,
  runWords,
  spawnedFeatures,
  updateWords,
} from "./stream-model";

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

/** A stream line of `kind`, for an update's header. */
const line = (kind: "merged" | "ask" | "failed", key: string) => ({
  key,
  kind,
  feature: "f",
  words: kind,
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

  it("gathers a run of digests into one update on the last, its cards and lines with it", () => {
    const features = [feature("rate-headers")];
    const plan = planStream(
      [digestMessage("d1", 1, digest(1, { features })), digestMessage("d2", 2, digest(2))],
      [card("rate-headers")],
    );
    // One update, on the last of the run: nothing of d1 is lost, it moves there.
    expect(plan.messages.map((message) => message.id)).toEqual(["d2"]);
    expect(plan.extras.get("d1")).toBeUndefined();
    expect(plan.extras.get("d2")?.cards).toEqual(["rate-headers"]);
    expect(plan.extras.get("d2")?.digests.map((each) => each.message.id)).toEqual(["d1", "d2"]);
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
      { line: { kind: "merged", threadId: A, pr: { number: 431 } }, at: 2 },
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

  it("heads an update with its counts, what needs you first, and its newest time", () => {
    const words = updateWords(
      [
        { line: line("merged", "a"), at: 10 },
        { line: line("merged", "b"), at: 10 },
        { line: line("merged", "c"), at: 12 },
        { line: line("ask", "d"), at: 14 },
      ],
      [entry("d1", 10, digest(1)), entry("d2", 14, digest(2))],
      clock,
    );
    expect(words.counts.map((count) => count.text)).toEqual(["1 waiting on you", "3 merged"]);
    expect(words.time).toBe("t14");
    expect(words.needsYou).toBe(true);
    const calm = updateWords(
      [{ line: line("merged", "a"), at: 3 }],
      [entry("d", 3, digest(1))],
      clock,
    );
    expect(calm.needsYou).toBe(false);
    expect(calm.counts.map((count) => count.text)).toEqual(["1 merged"]);
  });
});

/** The orchestrator's words, as a reply says them. */
const reply = (id: string, at: number, text: string): GramUIMessage => ({
  id,
  role: "assistant",
  metadata: { createdAt: at },
  parts: [{ type: "text", text }],
});

/** A digest whose worker merged #431: something the user should read. */
const mergedDigest = (generation: number) =>
  digest(generation, {
    changes: [
      {
        threadId: A,
        feature: "rate-headers",
        title: "Queue worker",
        from: "readyToMerge",
        to: "merged",
      },
    ],
    features: [
      feature("rate-headers", [
        worker({
          state: "merged",
          pr: { repo: "acme/api", number: 431, state: "merged", checks: "passing" },
        }),
      ]),
    ],
  });

const ids = (messages: readonly GramUIMessage[]) => messages.map((message) => message.id);

describe("the quiet stream", () => {
  it("folds digests that changed nothing for the user, and the replies to them, into one update", () => {
    const messages = [
      said("u1", 1, "user"),
      reply("a1", 2, "Started the release build."),
      digestMessage("d1", 3, digest(1)),
      reply("r1", 4, "Nothing is needed from you. Still building, 12 minutes in."),
      digestMessage("d2", 5, digest(2)),
      reply("r2", 6, "Still building, 16 minutes in."),
      digestMessage("d3", 7, digest(3)),
      reply("r3", 8, "**The release build** is 23 minutes in. Nothing is needed from you."),
    ];
    const plan = planStream(messages, [], { quiet: true });
    // The user's message and the reply to it stand; three digests and their replies are one line.
    expect(ids(plan.messages)).toEqual(["u1", "a1", "d3"]);
    const update = plan.extras.get("d3");
    expect(update?.digests.map((each) => each.message.id)).toEqual(["d1", "d2", "d3"]);
    expect(update?.replies?.map((each) => each.id)).toEqual(["r1", "r2", "r3"]);
    // Nothing is lost: every folded message says where it went.
    expect([...plan.foldedInto]).toEqual([
      ["d1", "d3"],
      ["r1", "d3"],
      ["d2", "d3"],
      ["r2", "d3"],
      ["r3", "d3"],
    ]);
    expect(replyPreview(update?.replies)).toBe(
      "The release build is 23 minutes in. Nothing is needed from you.",
    );
  });

  it("keeps every digest and reply as it was with all activity shown", () => {
    const messages = [
      digestMessage("d1", 1, digest(1)),
      reply("r1", 2, "Still building."),
      digestMessage("d2", 3, digest(2)),
      reply("r2", 4, "Still building."),
    ];
    const plan = planStream(messages, [], { quiet: false });
    expect(ids(plan.messages)).toEqual(["d1", "r1", "d2", "r2"]);
    expect(plan.extras.get("d2")?.replies).toBeUndefined();
    expect(plan.foldedInto.size).toBe(0);
  });

  it("never folds a merge, a failure, a question or the reply to one", () => {
    const failed = digest(3, {
      changes: [{ threadId: A, feature: "f", title: "Queue worker", from: "working", to: "error" }],
      features: [feature("f", [worker({ state: "error" })])],
    });
    const asks = digest(4, {
      changes: [
        { threadId: A, feature: "f", title: "Queue worker", from: "error", to: "question" },
      ],
      features: [feature("f", [worker({ state: "question" })])],
    });
    const messages = [
      digestMessage("d1", 1, digest(1)),
      reply("r1", 2, "Still building."),
      digestMessage("d2", 3, mergedDigest(2)),
      reply("r2", 4, "#431 merged."),
      digestMessage("d3", 5, failed),
      reply("r3", 6, "The queue worker stopped on an error."),
      digestMessage("d4", 7, asks),
      reply("r4", 8, "It asks you which retry policy to keep."),
      digestMessage("d5", 9, digest(5)),
      reply("r5", 10, "Still going."),
    ];
    const plan = planStream(messages, [], { quiet: true });
    expect(ids(plan.messages)).toEqual(["d1", "d2", "r2", "d3", "r3", "d4", "r4", "d5"]);
    expect(plan.extras.get("d1")?.replies?.map((each) => each.id)).toEqual(["r1"]);
    expect(plan.extras.get("d2")?.replies).toBeUndefined();
    expect(plan.extras.get("d5")?.replies?.map((each) => each.id)).toEqual(["r5"]);
  });

  it("never folds a boot or away digest, nor a reply that asks the user", () => {
    const asking: GramUIMessage = {
      id: "r3",
      role: "assistant",
      metadata: { createdAt: 6 },
      parts: [
        {
          type: "dynamic-tool",
          toolName: "mcp__gram__ask_user",
          toolCallId: "call-ask",
          state: "input-available",
          input: { question: "Ship it?" },
        },
      ],
    };
    const messages = [
      digestMessage("d1", 1, digest(1, { variant: "boot" })),
      reply("r1", 2, "Here is where things stand."),
      digestMessage("d2", 3, digest(2, { variant: "away", userAwayMinutes: 40 })),
      reply("r2", 4, "While you were away: nothing failed."),
      digestMessage("d3", 5, digest(3)),
      asking,
    ];
    const plan = planStream(messages, [], { quiet: true });
    expect(ids(plan.messages)).toEqual(["d1", "r1", "d2", "r2", "d3", "r3"]);
    expect(plan.foldedInto.size).toBe(0);
  });

  it("leaves digests no reply answered as their update was", () => {
    const messages = [digestMessage("d1", 1, digest(1)), digestMessage("d2", 2, digest(2))];
    const plan = planStream(messages, [], { quiet: true });
    expect(ids(plan.messages)).toEqual(["d2"]);
    expect(plan.extras.get("d2")).not.toHaveProperty("replies");
    expect(plan.extras.get("d2")?.digests.map((each) => each.message.id)).toEqual(["d1", "d2"]);
  });

  it("takes a folded reply's cards along to the update", () => {
    const messages = [
      digestMessage("d1", 1, digest(1)),
      spawning("s1", 2, "rate-headers"),
      said("u1", 3, "user"),
    ];
    const plan = planStream(messages, [card("rate-headers")], { quiet: true });
    expect(ids(plan.messages)).toEqual(["d1", "u1"]);
    expect(plan.extras.get("d1")?.cards).toEqual(["rate-headers"]);
    expect(plan.extras.get("s1")).toBeUndefined();
  });

  it("previews a reply's first line in plain words, and says nothing for a reply with no text", () => {
    expect(
      replyPreview([reply("r", 1, "\n## Status\n[#431](https://example.test/431) **merged**.")]),
    ).toBe("Status");
    expect(replyPreview([reply("r", 1, "- `ci` is green")])).toBe("ci is green");
    expect(replyPreview([spawning("s", 1, "f")])).toBeUndefined();
    expect(replyPreview([reply("a", 1, "Older."), spawning("s", 2, "f")])).toBe("Older.");
    expect(replyPreview([reply("r", 1, "x".repeat(400))])?.length).toBe(160);
  });
});

/** The quiet stream as an orchestrator's chat shows it: quiet episodes folded, then runs. */
const quietPlan = (messages: readonly GramUIMessage[], cards: readonly FeatureCard[] = []) =>
  planRuns(planStream(messages, cards, { quiet: true }), cards);

const mergedCard = (name: string): FeatureCard => ({ ...card(name), station: "merged" });

/** A digest whose worker now asks the user something. */
const askingDigest = (generation: number) =>
  digest(generation, {
    changes: [
      { threadId: A, feature: "f", title: "Queue worker", from: "working", to: "question" },
    ],
    features: [feature("f", [worker({ state: "question" })])],
  });

/** In `cardRows`' tests, a feature named m-something is merged. */
const namedMerged = (name: string) => name.startsWith("m");

/** A digest carrying one worker's progress report. */
const withReport = (generation: number) =>
  digest(generation, {
    reports: [
      { threadId: A, feature: "f", title: "Queue worker", state: "progress", summary: "Halfway." },
    ],
  } as unknown as Partial<OrchestrationDigest>);

describe("runs of quiet rows", () => {
  it("collapses updates with nothing between them into one row on the last, and says where each went", () => {
    const messages = [
      said("u1", 1, "user"),
      digestMessage("d1", 2, digest(1)),
      reply("r1", 3, "Still building."),
      digestMessage("d2", 4, mergedDigest(2)),
      reply("r2", 5, "#431 merged."),
    ];
    const plan = quietPlan(messages);
    // The quiet update (d1 with its reply) and the merge's update stood one under the other.
    expect(ids(plan.messages)).toEqual(["u1", "d2", "r2"]);
    const run = plan.extras.get("d2")?.run;
    expect(run?.map((part) => (part.kind === "update" ? part.messageId : part.feature))).toEqual([
      "d1",
      "d2",
    ]);
    // The row is the run alone: its own update is in it, not beside it.
    expect(plan.extras.get("d2")).toMatchObject({ lines: [], digests: [], cards: [] });
    expect(plan.extras.has("d1")).toBe(false);
    // A search for what the run holds lands on its row, including what d1 had folded.
    expect(plan.foldedInto.get("d1")).toBe("d2");
    expect(plan.foldedInto.get("r1")).toBe("d2");
    // Nothing it folded is lost: d1's reply is still in its part.
    const first = run?.[0];
    expect(first?.kind === "update" ? first.replies?.map((each) => each.id) : undefined).toEqual([
      "r1",
    ]);
    expect(runWords(run ?? [], clock)).toEqual({
      counts: [{ kind: "merged", text: "1 merged" }],
      // Its digests carry no report; the merge's carries one change.
      digest: "1 change",
      time: "t2–t4",
      needsYou: false,
    });
  });

  it("leaves a single update as it is, and the plan it was given untouched", () => {
    const messages = [
      said("u1", 1, "user"),
      digestMessage("d1", 2, mergedDigest(1)),
      said("r1", 3),
    ];
    const quiet = planStream(messages, [], { quiet: true });
    expect(planRuns(quiet, [])).toBe(quiet);
    expect(quiet.extras.get("d1")?.run).toBeUndefined();
  });

  it("never runs across a reply or a message of the user's", () => {
    const messages = [
      digestMessage("d1", 1, mergedDigest(1)),
      reply("r1", 2, "#431 merged."),
      digestMessage("d2", 3, mergedDigest(2)),
      said("u1", 4, "user"),
      digestMessage("d3", 5, mergedDigest(3)),
    ];
    const plan = quietPlan(messages);
    expect(ids(plan.messages)).toEqual(["d1", "r1", "d2", "u1", "d3"]);
    for (const id of ["d1", "d2", "d3"]) expect(plan.extras.get(id)?.run).toBeUndefined();
  });

  it("takes merged features' lines next to an update into its run, and leaves the reply they followed", () => {
    const messages = [
      said("u1", 1, "user"),
      spawning("s1", 2, "history-sort"),
      digestMessage("d1", 3, mergedDigest(1)),
      reply("r1", 4, "#431 merged."),
    ];
    const plan = quietPlan(messages, [mergedCard("history-sort")]);
    expect(ids(plan.messages)).toEqual(["u1", "s1", "d1", "r1"]);
    // The spawn's reply stands; the merged line under it joins the update below.
    expect(plan.extras.get("s1")?.cards).toEqual([]);
    const run = plan.extras.get("d1")?.run;
    expect(run?.map((part) => part.kind)).toEqual(["merged", "update"]);
    expect(runWords(run ?? [], clock).counts).toEqual([{ kind: "merged", text: "2 merged" }]);
  });

  it("counts a merged line once when an update in the run already said it merged", () => {
    const messages = [
      digestMessage("d1", 1, digest(1)),
      reply("r1", 2, "Still going."),
      digestMessage("d2", 3, mergedDigest(2)),
    ];
    const plan = quietPlan(messages, [mergedCard("rate-headers")]);
    const run = plan.extras.get("d2")?.run;
    expect(run?.map((part) => part.kind)).toEqual(["update", "update", "merged"]);
    expect(runWords(run ?? [], clock).counts).toEqual([{ kind: "merged", text: "1 merged" }]);
  });

  it("ends a run at a live card, which stays a card under the run's row", () => {
    const merging = mergedDigest(2);
    const messages = [
      digestMessage("d1", 1, digest(1)),
      reply("r1", 2, "Still going."),
      // The merge's digest also carries a live feature, whose card it anchors.
      digestMessage("d2", 3, {
        ...merging,
        features: [...merging.features, feature("mail-trigger")],
      }),
      reply("r2", 4, "#431 merged; mail trigger is working."),
    ];
    const plan = quietPlan(messages, [card("mail-trigger")]);
    expect(ids(plan.messages)).toEqual(["d2", "r2"]);
    expect(plan.extras.get("d2")?.run?.map((part) => part.kind)).toEqual(["update", "update"]);
    expect(plan.extras.get("d2")?.cards).toEqual(["mail-trigger"]);
  });

  it("says an ask or a failure inside a run on its row, first and toned", () => {
    const messages = [
      digestMessage("d1", 1, digest(1)),
      reply("r1", 2, "Still going."),
      digestMessage("d2", 3, askingDigest(2)),
      reply("r2", 4, "It asks you which retry policy to keep."),
    ];
    const plan = quietPlan(messages);
    expect(ids(plan.messages)).toEqual(["d2", "r2"]);
    const words = runWords(plan.extras.get("d2")?.run ?? [], clock);
    expect(words.counts[0]).toEqual({ kind: "ask", text: "1 waiting on you" });
    expect(words.needsYou).toBe(true);
  });

  it("folds two or more merged lines in a row among a message's cards, never a live card", () => {
    expect(cardRows(["m1", "m2", "m3", "live", "m4", "live2", "m5", "m6"], namedMerged)).toEqual([
      {
        kind: "run",
        parts: [
          { kind: "merged", feature: "m1" },
          { kind: "merged", feature: "m2" },
          { kind: "merged", feature: "m3" },
        ],
      },
      { kind: "card", feature: "live" },
      // A lone merged line stays a line.
      { kind: "card", feature: "m4" },
      { kind: "card", feature: "live2" },
      {
        kind: "run",
        parts: [
          { kind: "merged", feature: "m5" },
          { kind: "merged", feature: "m6" },
        ],
      },
    ]);
    // Merged lines alone read as their count, with no time.
    const words = runWords(
      [
        { kind: "merged", feature: "m1" },
        { kind: "merged", feature: "m2" },
      ],
      clock,
    );
    expect(words).toEqual({
      counts: [{ kind: "merged", text: "2 merged" }],
      digest: undefined,
      time: undefined,
      needsYou: false,
    });
  });

  it("gives a run one time when its updates came at once, and its digests' reports summed", () => {
    const words = runWords(
      [
        { kind: "update", messageId: "d1", lines: [], digests: [entry("d1", 5, withReport(1))] },
        { kind: "update", messageId: "d2", lines: [], digests: [entry("d2", 5, withReport(2))] },
      ],
      clock,
    );
    expect(words).toEqual({ counts: [], digest: "2 reports", time: "t5", needsYou: false });
  });
});
