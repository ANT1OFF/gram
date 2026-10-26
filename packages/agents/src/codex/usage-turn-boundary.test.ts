import { MessageId, type AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { makeCodexMapper } from "./mapper.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import { makeCodexUsageLedger } from "./usage.ts";

const counts = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: inputTokens + outputTokens,
});
const value = (inputTokens: number) => ({ inputTokens, outputTokens: 0 });
const setup = () => {
  let sequence = 0;
  const mapper = makeCodexMapper({
    threadId: "session",
    freshSession: true,
    newMessageId: () => MessageId.make(`boundary-${++sequence}`),
  });
  const boundary = (id: string, status: "inProgress" | "completed" | "interrupted" | "failed") =>
    mapper.map({
      method: status === "inProgress" ? "turn/started" : "turn/completed",
      params: {
        threadId: "session",
        turn: {
          id,
          status,
          items: [],
          itemsView: "full",
          rootTurnId: null,
          error: null,
          startedAt: 1,
          completedAt: status === "inProgress" ? null : 2,
          durationMs: null,
        },
      },
    } as ServerNotification);
  const report = (id: string, total: unknown, last: unknown, threadId = "session") =>
    mapper.map({
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId: id, tokenUsage: { total, last, modelContextWindow: null } },
    } as ServerNotification);
  return { mapper, boundary, report };
};
const usage = (events: AgentEvent[]) => events.filter((event) => event.type === "usage");
const finish = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === "chunk"
      ? event.chunk.type === "finish-step" || event.chunk.type === "finish"
        ? [event.chunk.type]
        : []
      : event.type === "turnEnd"
        ? [event.reason]
        : [],
  );

for (const end of ["completed", "interrupted", "failed", "flush", "next-start"] as const)
  it(`primary-stable reception after ${end} cannot inherit last usage and real later increments recover`, () => {
    const { mapper, boundary, report } = setup();
    boundary("first", "inProgress");
    report("first", counts(10, 0), counts(10, 0));
    if (end !== "next-start") {
      const finished = end === "flush" ? mapper.flush() : boundary("first", end);
      expect(finish(finished)).toEqual([
        "finish-step",
        "finish",
        end === "flush" || end === "failed" ? "error" : end,
      ]);
    }
    const opened = boundary("second", "inProgress");
    if (end === "next-start")
      expect(finish(opened)).toEqual(["finish-step", "finish", "completed"]);
    const refined = { ...counts(10, 0), cachedInputTokens: 5 };
    expect(report("second", refined, refined, "foreign")).toEqual([]);
    expect(usage(report("second", refined, refined))).toEqual([]);
    const ended = boundary("second", "completed");
    expect(usage(ended)).toEqual([]);
    expect(finish(ended)).toEqual(["finish-step", "finish", "completed"]);
    expect(report("second", counts(999, 0), counts(999, 0))).toEqual([]);
    boundary("third", "inProgress");
    const total = { ...counts(20, 0), cachedInputTokens: 10 },
      last = { ...counts(10, 0), cachedInputTokens: 5 };
    expect(usage(report("third", total, last))[0]).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 0 },
      telemetryVersion: "codex-request-delta-v1",
    });
    expect(finish(boundary("third", "completed"))).toEqual(["finish-step", "finish", "completed"]);
  });

it("live auxiliary conflict updates known primary usage without fabricating another request or zero", () => {
  const { boundary, report } = setup();
  boundary("known", "inProgress");
  const first = counts(10, 0),
    refined = { ...first, cachedInputTokens: 5 };
  expect(usage(report("known", first, first))[0]).toMatchObject({
    tokens: { inputTokens: 10, cacheReadTokens: 0 },
  });
  const updated = usage(report("known", refined, refined));
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 0 },
    partial: true,
    telemetryVersion: "codex-request-delta-v1",
  });
  expect(updated[0]?.tokens).toEqual({ inputTokens: 10, outputTokens: 0 });
  const ended = boundary("known", "completed");
  expect(usage(ended)[0]?.tokens).toEqual({ inputTokens: 10, outputTokens: 0 });
  expect(finish(ended)).toEqual(["finish-step", "finish", "completed"]);
});

describe("Codex telemetry continuity at actual turn boundaries", () => {
  for (const end of ["completed", "interrupted", "failed", "flush", "next-start"] as const) {
    for (const gap of ["absent", "null", "invalid", "zero"] as const) {
      it(`preserves known prior usage across ${gap} telemetry with ${end}`, () => {
        const { mapper, boundary, report } = setup();
        boundary("prior", "inProgress");
        report("prior", counts(100, 10), counts(100, 10));
        expect(usage(boundary("prior", "completed"))[0]).toMatchObject({
          tokens: { inputTokens: 100, outputTokens: 10 },
          telemetryVersion: "codex-request-delta-v1",
        });
        boundary("gap", "inProgress");
        if (gap === "null") report("gap", null, null);
        if (gap === "invalid") report("gap", counts(-1, 0), counts(-1, 0));
        if (gap === "zero") report("gap", counts(100, 10), counts(0, 0));
        if (end !== "next-start") {
          const ended = end === "flush" ? mapper.flush() : boundary("gap", end);
          expect(usage(ended)).toHaveLength(gap === "zero" ? 1 : 0);
          expect(finish(ended)).toEqual([
            "finish-step",
            "finish",
            end === "interrupted"
              ? "interrupted"
              : end === "failed" || end === "flush"
                ? "error"
                : "completed",
          ]);
        }
        const opened = boundary("current", "inProgress");
        if (end === "next-start") {
          expect(usage(opened)).toHaveLength(gap === "zero" ? 1 : 0);
          expect(finish(opened)).toEqual(["finish-step", "finish", "completed"]);
        }
        // Ended-turn replay and wrong-owner reports must not restore a stale baseline.
        expect(report("gap", counts(200, 20), counts(100, 10))).toEqual([]);
        expect(report("current", counts(200, 20), counts(100, 10), "other")).toEqual([]);
        const total = gap === "zero" ? counts(110, 11) : counts(210, 21);
        report("current", total, counts(10, 1));
        expect(usage(boundary("current", "completed"))[0]).toMatchObject({
          tokens: { inputTokens: 10, outputTokens: 1 },
          telemetryVersion: gap === "zero" ? "codex-request-delta-v1" : "codex-last-request-v1",
          ...(gap === "zero" ? {} : { partial: true }),
        });
        boundary("recovered", "inProgress");
        report("recovered", counts(total.inputTokens + 10, total.outputTokens + 1), counts(10, 1));
        expect(usage(boundary("recovered", "completed"))[0]).toMatchObject({
          tokens: { inputTokens: 10, outputTokens: 1 },
          telemetryVersion: "codex-request-delta-v1",
        });
      });
    }
  }
  it("refuses delayed ended-turn telemetry even while idle, but accepts a new idle observed baseline", () => {
    const { boundary, report } = setup();
    boundary("gap", "inProgress");
    boundary("gap", "completed");
    expect(report("gap", counts(100, 10), counts(100, 10))).toEqual([]);
    boundary("next", "inProgress");
    report("next", counts(110, 11), counts(10, 1));
    expect(usage(boundary("next", "completed"))[0]).toMatchObject({
      partial: true,
      telemetryVersion: "codex-last-request-v1",
      tokens: { inputTokens: 10, outputTokens: 1 },
    });
    expect(report("resume-baseline", counts(200, 20), null)).toEqual([]);
    boundary("new", "inProgress");
    report("new", counts(210, 21), counts(10, 1));
    expect(usage(boundary("new", "completed"))[0]).toMatchObject({
      telemetryVersion: "codex-request-delta-v1",
      tokens: { inputTokens: 10, outputTokens: 1 },
    });
  });
  it("invalidates a malformed tail after known usage without discarding the known contribution", () => {
    const { boundary, report } = setup();
    boundary("prior", "inProgress");
    report("prior", counts(100, 10), counts(100, 10));
    report("prior", null, null);
    expect(usage(boundary("prior", "completed"))[0]).toMatchObject({
      partial: true,
      tokens: { inputTokens: 100, outputTokens: 10 },
    });
    boundary("current", "inProgress");
    report("current", counts(210, 21), counts(10, 1));
    expect(usage(boundary("current", "completed"))[0]).toMatchObject({
      partial: true,
      telemetryVersion: "codex-last-request-v1",
      tokens: { inputTokens: 10, outputTokens: 1 },
    });
  });
  it("does not let repeated malformed telemetry cross a freshly observed baseline", () => {
    const ledger = makeCodexUsageLedger(true);
    ledger.startTurn();
    ledger.observe(undefined, undefined);
    ledger.observe({ inputTokens: 100, outputTokens: 10 }, undefined);
    ledger.observe(undefined, undefined);
    ledger.endTurn();
    ledger.startTurn();
    expect(
      ledger.observe({ inputTokens: 210, outputTokens: 21 }, { inputTokens: 10, outputTokens: 1 }),
    ).toEqual({
      tokens: { inputTokens: 10, outputTokens: 1 },
      basis: "last-request",
      partial: true,
    });
  });
});

describe("refused/invalid telemetry preserves replay proof and invalidates continuity", () => {
  for (const missing of ["null", "invalid", "contradictory", "manual"] as const) {
    it(`does not recount known usage after repeated ${missing} gaps in the same scope`, () => {
      const ledger = makeCodexUsageLedger(true);
      ledger.startTurn();
      expect(ledger.observe(value(10), value(10))).toEqual({
        tokens: value(10),
        basis: "delta",
        partial: false,
      });
      const gap = () => {
        if (missing === "manual") ledger.invalidateBaseline();
        else
          ledger.observe(
            missing === "null" ? undefined : value(missing === "invalid" ? -1 : 1),
            missing === "null" ? undefined : value(2),
          );
      };
      gap();
      gap();
      expect(ledger.observe(value(10), value(10)).tokens).toBeUndefined();
      // An old replay is not a fresh cumulative observation after the gap.
      ledger.endTurn();
      ledger.startTurn();
      expect(ledger.observe(value(20), value(1))).toEqual({
        tokens: value(1),
        basis: "last-request",
        partial: true,
      });
      ledger.endTurn();
      ledger.startTurn();
      expect(ledger.observe(value(21), value(1))).toEqual({
        tokens: value(1),
        basis: "delta",
        partial: false,
      });
    });
  }
  for (const last of [value(1), value(0), undefined]) {
    it(`keeps the full 4096-stamp cap and future request evidence last=${JSON.stringify(last)}`, () => {
      const ledger = makeCodexUsageLedger(true);
      ledger.startTurn();
      let known = 0;
      for (let i = 1; i <= 4096; i++)
        known += ledger.observe(value(i), value(1)).tokens?.inputTokens ?? 0;
      expect(known).toBe(4096);
      const retained = ledger.retainedBytes();
      expect(ledger.observe(value(4096), value(1))).toEqual({ partial: false });
      expect(ledger.retainedBytes()).toBe(retained);
      for (let i = 4097; i <= 4100; i++) {
        expect(ledger.observe(value(i), value(1))).toEqual({ partial: true });
        expect(ledger.observe(undefined, undefined)).toEqual({ partial: true });
        expect(ledger.observe(value(4096), value(1))).toEqual({ partial: false });
      }
      expect(ledger.retainedBytes()).toBeLessThanOrEqual(retained);
      ledger.endTurn();
      ledger.startTurn();
      expect(ledger.observe(value(4101), last)).toEqual(
        last === undefined
          ? { partial: true }
          : { tokens: last, basis: "last-request", partial: true },
      );
      expect(ledger.observe(value(4101), last).tokens).toBeUndefined();
      ledger.endTurn();
      ledger.startTurn();
      expect(ledger.observe(value(4102), value(1))).toEqual({
        tokens: value(1),
        basis: "delta",
        partial: false,
      });
    });
  }
  it("does not convert an exact duplicate at capacity into a continuity gap", () => {
    const ledger = makeCodexUsageLedger(true);
    ledger.startTurn();
    for (let i = 1; i <= 4096; i++) ledger.observe(value(i), value(1));
    for (let i = 0; i < 3; i++)
      expect(ledger.observe(value(4096), value(1))).toEqual({ partial: false });
    ledger.endTurn();
    ledger.startTurn();
    expect(ledger.observe(value(4097), value(1))).toEqual({
      tokens: value(1),
      basis: "delta",
      partial: false,
    });
  });
});

for (const last of [counts(0, 0), undefined]) {
  it(`live mapper retains a real zero or unknown after cap refusal, last=${JSON.stringify(last)}`, () => {
    const { boundary, report } = setup();
    boundary("old", "inProgress");
    for (let i = 1; i <= 4097; i++) report("old", counts(i, 0), counts(1, 0));
    const prior = usage(boundary("old", "interrupted"));
    expect(prior[0]).toMatchObject({
      tokens: { inputTokens: 4096, outputTokens: 0 },
      partial: true,
    });
    boundary("current", "inProgress");
    report("current", counts(4100, 0), last ?? null);
    const current = usage(boundary("current", "completed"));
    if (last === undefined) expect(current).toEqual([]);
    else
      expect(current[0]).toMatchObject({
        tokens: { inputTokens: 0, outputTokens: 0 },
        partial: true,
        telemetryVersion: "codex-last-request-v1",
      });
    boundary("observed", "inProgress");
    report("observed", counts(4101, 0), counts(1, 0));
    expect(usage(boundary("observed", "completed"))[0]).toMatchObject({
      tokens: { inputTokens: 1, outputTokens: 0 },
      telemetryVersion: "codex-request-delta-v1",
    });
  });
}

for (const gap of ["absent", "null", "invalid"] as const) {
  for (const end of ["completed", "interrupted", "failed", "flush", "next-start"] as const) {
    it(`suppressed last remains inadmissible through ${gap} and ${end}, then real telemetry recovers`, () => {
      const { mapper, boundary, report } = setup();
      boundary("prior", "inProgress");
      expect(usage(report("prior", counts(10, 0), counts(10, 0)))[0]?.tokens.inputTokens).toBe(10);
      expect(finish(boundary("prior", "completed"))).toEqual([
        "finish-step",
        "finish",
        "completed",
      ]);
      boundary("suppressed", "inProgress");
      const refined = { ...counts(10, 0), cachedInputTokens: 5 };
      expect(usage(report("suppressed", refined, refined))).toEqual([]);
      if (gap === "null") expect(usage(report("suppressed", null, null))).toEqual([]);
      if (gap === "invalid")
        expect(usage(report("suppressed", counts(-1, 0), counts(-1, 0)))).toEqual([]);
      const stale = { ...refined, cachedInputTokens: 4 };
      expect(report("suppressed", undefined, stale, "foreign")).toEqual([]);
      expect(usage(report("suppressed", undefined, stale))).toEqual([]);
      expect(usage(report("suppressed", undefined, stale))).toEqual([]);
      if (end !== "next-start") {
        const ended = end === "flush" ? mapper.flush() : boundary("suppressed", end);
        expect(usage(ended)).toEqual([]);
        expect(finish(ended)).toEqual([
          "finish-step",
          "finish",
          end === "failed" || end === "flush" ? "error" : end,
        ]);
      }
      const opened = boundary("current", "inProgress");
      if (end === "next-start")
        expect(finish(opened)).toEqual(["finish-step", "finish", "completed"]);
      expect(report("suppressed", counts(999, 0), counts(999, 0))).toEqual([]);
      expect(usage(report("current", undefined, refined))).toEqual([]);
      const actual = usage(report("current", { ...counts(20, 0), cachedInputTokens: 10 }, refined));
      expect(actual).toHaveLength(1);
      expect(actual[0]).toMatchObject({
        tokens: { inputTokens: 10, outputTokens: 0 },
        telemetryVersion: "codex-last-request-v1",
        partial: true,
      });
      const ended = boundary("current", "completed");
      expect(usage(ended)[0]?.tokens.inputTokens).toBe(10);
      expect(finish(ended)).toEqual(["finish-step", "finish", "completed"]);
      expect(report("current", counts(999, 0), counts(999, 0))).toEqual([]);
    });
  }
}

for (const end of ["completed", "interrupted", "failed", "flush", "next-start"] as const) {
  it(`insufficient primary change cannot release a suppressed last across ${end}`, () => {
    const { mapper, boundary, report } = setup();
    boundary("prior", "inProgress");
    expect(usage(report("prior", counts(10, 0), counts(10, 0)))[0]?.tokens.inputTokens).toBe(10);
    expect(finish(boundary("prior", "completed"))).toEqual(["finish-step", "finish", "completed"]);
    boundary("suppressed", "inProgress");
    const stable = { ...counts(10, 0), cachedInputTokens: 5 };
    expect(usage(report("suppressed", stable, stable))).toEqual([]);
    expect(usage(report("suppressed", null, null))).toEqual([]);
    expect(finish(boundary("suppressed", "completed"))).toEqual([
      "finish-step",
      "finish",
      "completed",
    ]);
    boundary("current", "inProgress");
    const ambiguousTotal = { ...counts(15, 0), cachedInputTokens: 7 },
      ambiguousLast = { ...counts(10, 0), cachedInputTokens: 7 };
    expect(report("current", ambiguousTotal, ambiguousLast, "foreign")).toEqual([]);
    expect(usage(report("current", ambiguousTotal, ambiguousLast))).toEqual([]);
    expect(usage(report("current", ambiguousTotal, ambiguousLast))).toEqual([]);
    expect(usage(report("current", undefined, ambiguousLast))).toEqual([]);
    if (end !== "next-start") {
      const ended = end === "flush" ? mapper.flush() : boundary("current", end);
      expect(usage(ended)).toEqual([]);
      expect(finish(ended)).toEqual([
        "finish-step",
        "finish",
        end === "failed" || end === "flush" ? "error" : end,
      ]);
    }
    const opened = boundary("recovery", "inProgress");
    if (end === "next-start")
      expect(finish(opened)).toEqual(["finish-step", "finish", "completed"]);
    expect(report("current", counts(999, 0), counts(999, 0))).toEqual([]);
    const recovered = usage(
      report(
        "recovery",
        { ...counts(20, 0), cachedInputTokens: 9 },
        { ...counts(5, 0), cachedInputTokens: 2 },
      ),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      tokens: { inputTokens: 5, outputTokens: 0 },
      telemetryVersion: "codex-last-request-v1",
      partial: true,
    });
    const ended = boundary("recovery", "completed");
    expect(usage(ended)[0]?.tokens.inputTokens).toBe(5);
    expect(finish(ended)).toEqual(["finish-step", "finish", "completed"]);
    expect(report("recovery", counts(999, 0), counts(999, 0))).toEqual([]);
  });
}
