import { describe, expect, it } from "vitest";
import {
  addSample,
  classifyMachine,
  classifyThread,
  closeWake,
  IDLE_GRACE_MS,
  type IdleSpan,
  type IdleThreadFacts,
  limitOnWake,
  lookAtWake,
  percentile,
  resumeSegments,
  SAMPLE_EVERY_MS,
  summarize,
  type WakeLook,
} from "./idle-measure.ts";

/** A worker at rest that reported, with nothing armed and nothing running. */
const idle = (extra: Partial<IdleThreadFacts> = {}): IdleThreadFacts => ({
  status: "idle",
  queued: 0,
  pendingRequests: 0,
  background: 0,
  terminalBusy: false,
  wakes: [],
  runWatches: 0,
  prMonitored: false,
  limitWait: false,
  reportStands: false,
  reported: true,
  worker: true,
  saveFailed: false,
  ...extra,
});

const blockersOf = (facts: Partial<IdleThreadFacts>) => classifyThread(idle(facts)).blockers;
const triggersOf = (facts: Partial<IdleThreadFacts>) => classifyThread(idle(facts)).triggers;

describe("classifyThread", () => {
  it("passes a worker at rest waiting on its PR's monitor, labelled CI or review", () => {
    expect(classifyThread(idle({ prMonitored: true }))).toEqual({
      blockers: [],
      triggers: ["ciReview"],
    });
  });

  it("holds each gate on its own blocker", () => {
    expect(blockersOf({ status: "running" })).toEqual(["turn"]);
    expect(blockersOf({ compacting: true })).toEqual(["turn"]);
    expect(blockersOf({ subagents: true })).toEqual(["subagent"]);
    expect(blockersOf({ queued: 1 })).toEqual(["queued"]);
    expect(blockersOf({ status: "needsApproval" })).toEqual(["interaction"]);
    expect(blockersOf({ background: 2 })).toEqual(["background"]);
    expect(blockersOf({ terminalBusy: true })).toEqual(["terminal"]);
    expect(blockersOf({ saveFailed: true })).toEqual(["unsaved"]);
  });

  it("holds a machine whose terminals couldn't be read, rather than guess them idle", () => {
    expect(classifyThread(idle({ terminalBusy: undefined })).blockers).toEqual(["localUnknown"]);
  });

  it("holds a wake that reads the machine itself, and passes one this server fires", () => {
    expect(classifyThread(idle({ wakes: [{ condition: "machine" }] }))).toEqual({
      blockers: ["localWake"],
      triggers: ["scheduleWake"],
    });
    expect(classifyThread(idle({ wakes: [{ condition: "ciStuck" }, {}] }))).toEqual({
      blockers: [],
      triggers: ["scheduleWake"],
    });
    expect(
      classifyThread(idle({ wakes: [{ onPr: { repo: "o/r", number: 1 } }] })).triggers,
    ).toEqual(["ciReview"]);
  });

  it("labels each wait by what will give the thread its next turn", () => {
    expect(triggersOf({ pendingRequests: 1 })).toEqual(["user"]);
    expect(triggersOf({ reportStands: true })).toEqual(["orchestrator"]);
    expect(triggersOf({ runWatches: 1 })).toEqual(["runMonitor"]);
    expect(triggersOf({ limitWait: true })).toEqual(["limit"]);
    expect(triggersOf({ runWatches: 1, prMonitored: true })).toEqual(["ciReview", "runMonitor"]);
    expect(triggersOf({})).toEqual(["orchestrator"]);
    expect(triggersOf({ reported: false })).toEqual(["unknown"]);
    expect(triggersOf({ worker: false, reported: false })).toEqual(["user"]);
  });
});

describe("classifyMachine", () => {
  it("is eligible only when every thread on it passes, with the blockers of all", () => {
    expect(classifyMachine(true, [idle(), idle({ runWatches: 1 })]).state).toBe("eligible");
    expect(
      classifyMachine(true, [idle(), idle({ queued: 1 }), idle({ terminalBusy: true })]),
    ).toEqual({
      state: "blocked",
      blockers: ["queued", "terminal"],
      triggers: ["orchestrator"],
    });
  });

  it("counts an away machine and one with no work apart from idle ones", () => {
    expect(classifyMachine(false, [idle()]).state).toBe("offline");
    expect(classifyMachine(true, []).state).toBe("finished");
  });
});

const M = { name: "worker-a", kind: "relayed" as const };
const minute = SAMPLE_EVERY_MS;
const sampled = (states: ReadonlyArray<Parameters<typeof classifyMachine>[1] | "off">, start = 0) =>
  states.reduce<ReadonlyArray<IdleSpan>>(
    (spans, threads, i) =>
      addSample(
        spans,
        M,
        threads === "off" ? classifyMachine(false, []) : classifyMachine(true, threads),
        start + i * minute,
      ),
    [],
  );

describe("spans and their summary", () => {
  it("merges samples that read the same, and splits on a change or a gap", () => {
    const spans = sampled([[idle()], [idle()], [idle({ status: "running" })]]);
    expect(spans.map((span) => [span.state, span.from, span.to])).toEqual([
      ["eligible", 0, 2 * minute],
      ["blocked", 2 * minute, 3 * minute],
    ]);
    const after = addSample(spans, M, classifyMachine(true, [idle()]), 10 * minute);
    expect(after.at(-1)).toMatchObject({ from: 10 * minute, eligibleSince: 10 * minute });
    expect(after.at(-2)!.to).toBe(3 * minute);
  });

  it("keeps the eligible run's start across a change of what it waits for", () => {
    const spans = sampled([[idle()], [idle({ runWatches: 1 })]]);
    expect(spans.map((span) => span.eligibleSince)).toEqual([0, 0]);
  });

  it("counts eligible minutes past the warm minute, and blocked minutes by gate", () => {
    const spans = sampled([
      [idle({ prMonitored: true })],
      [idle({ prMonitored: true })],
      [idle({ prMonitored: true })],
      [idle({ prMonitored: true })],
      [idle({ status: "running", terminalBusy: true })],
      "off",
    ]);
    const summary = summarize(spans, [], 0, 6 * minute);
    expect(summary.minutes).toMatchObject({
      eligible: 4,
      eligibleAfterWarmMinute: (4 * minute - IDLE_GRACE_MS) / minute,
      blocked: 1,
      offline: 1,
    });
    expect(summary.eligiblePct).toBe(60);
    expect(summary.blockedByGate).toEqual({ activity: 1, localWork: 1 });
    expect(summary.blockedBy).toEqual({ turn: 1, terminal: 1 });
    expect(summary.eligibleWaitingOn).toEqual({ ciReview: 3 });
  });

  it("clips spans to the window asked for", () => {
    const spans = sampled([[idle()], [idle()], [idle()], [idle()]]);
    expect(summarize(spans, [], 2 * minute, 3 * minute).minutes).toMatchObject({
      eligible: 1,
      eligibleAfterWarmMinute: 1,
    });
  });
});

describe("cold wake timings", () => {
  const look = (extra: Partial<WakeLook>): WakeLook => ({ ...M, settled: false, ...extra });
  const W = { machine: M.name, kind: M.kind };

  it("follows a wake from the session that wanted it to the first turn, apart from a limit", () => {
    let wake = lookAtWake(undefined, look({ wantedSince: 1_000 }), 1_200);
    expect(wake).toEqual({ ...W, wakeAt: 1_000 });
    wake = lookAtWake(wake, look({ wantedSince: 1_000 }), 5_000);
    wake = lookAtWake(wake, look({ onlineSince: 21_000 }), 21_500);
    wake = lookAtWake(wake, look({ onlineSince: 21_000, settled: true }), 30_000);
    wake = limitOnWake(wake!, true, 31_000);
    wake = limitOnWake(wake, false, 91_000);
    const timing = closeWake(wake, 95_000, "turn");
    expect(resumeSegments(timing)).toEqual({
      machine: 20_000,
      worktree: 9_000,
      session: 5_000,
      limit: 60_000,
      total: 94_000,
    });
  });

  it("opens no wake for a machine wanted while it is up, and forgets a reconnect it lost", () => {
    expect(lookAtWake(undefined, look({ wantedSince: 1, onlineSince: 0 }), 2)).toBeUndefined();
    const back = lookAtWake({ ...W, wakeAt: 0 }, look({ onlineSince: 10 }), 11);
    expect(lookAtWake(back, look({}), 12)?.onlineAt).toBeUndefined();
  });

  it("counts a limit still being waited out when the first turn starts", () => {
    const wake = limitOnWake({ ...W, wakeAt: 0, onlineAt: 1, readyAt: 2 }, true, 10);
    expect(closeWake(wake, 40, "turn").limitMs).toBe(30);
  });

  it("reports the latency distribution of the wakes in the window", () => {
    const wakes = [10, 20, 30, 40, 100].map((seconds, i) => ({
      ...W,
      wakeAt: i * 1_000,
      firstTurnAt: i * 1_000 + seconds * 1_000,
      outcome: "turn" as const,
    }));
    const summary = summarize(
      [],
      [...wakes, { ...W, wakeAt: 9_000, outcome: "abandoned" as const }],
      0,
      10_000,
    );
    expect(summary.resume).toMatchObject({
      wakes: 6,
      abandoned: 1,
      total: { count: 5, p50Ms: 30_000, p95Ms: 100_000 },
    });
    expect(percentile([], 50)).toBeUndefined();
  });
});
