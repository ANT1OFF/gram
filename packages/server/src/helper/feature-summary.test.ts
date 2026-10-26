import { describe, expect, it } from "@effect/vitest";
import type {
  FeatureCard,
  FeatureCardSummary,
  ThreadId,
  WorkerReport,
  WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import { makeFeatureSummaries, validFeatureSummary } from "./feature-summary.ts";
import type { HelperJob, HelperResult } from "./scheduler.ts";

const W = "w-1" as WorkspaceId;
const O = "t-orch" as ThreadId;
const A = "t-a" as ThreadId;

const card = (patch: Partial<FeatureCard> = {}): FeatureCard => ({
  workspaceId: W,
  feature: "mail-trigger",
  station: "checks",
  version: 3,
  workers: [
    {
      threadId: A,
      title: "Endpoint",
      project: "api",
      state: "inReview",
      station: "checks",
      now: "checks running",
      prs: [{ repo: "acme/api", number: 212, state: "open", checks: "pending" }],
      overlapsWith: [],
      overlapFiles: [],
    },
  ],
  createdAt: 1,
  updatedAt: 2,
  ...patch,
});

const harness = (cards: FeatureCard[], result: HelperResult<{ summary: string }>) => {
  const jobs: HelperJob<unknown, unknown>[] = [];
  const written: FeatureCardSummary[] = [];
  const summaries = makeFeatureSummaries({
    schedule: (job) =>
      Effect.sync(() => {
        jobs.push(job as HelperJob<unknown, unknown>);
        return result as never;
      }),
    orchestratorOf: () => Effect.succeed(O),
    cards: () => Effect.succeed(cards),
    latestReports: () =>
      Effect.succeed([
        { threadId: A, state: "progress", summary: "Endpoint up; waits on the form.", at: 5 },
      ] satisfies WorkerReport[]),
    putSummary: (_workspace, _feature, summary) =>
      Effect.sync(() => {
        written.push(summary);
        return true;
      }),
  });
  return { summaries, jobs, written };
};

describe("feature card summary", () => {
  it.effect(
    "goes through the scheduler as a recap scoped to the feature, and lands on its version",
    () =>
      Effect.gen(function* () {
        const { summaries, jobs, written } = harness([card()], {
          _tag: "Done",
          value: { summary: "Endpoint in review, waiting on the form." },
          cached: false,
        });
        const summary = yield* summaries(W, "mail-trigger");
        expect(summary).toEqual({ text: "Endpoint in review, waiting on the form.", version: 3 });
        expect(written).toEqual([summary]);
        expect(jobs[0]).toMatchObject({
          kind: "recap",
          threadId: O,
          scope: "feature:mail-trigger",
          lane: "background",
        });
      }),
  );

  it.effect("keys its cache by what the card says, not its now lines or times", () =>
    Effect.gen(function* () {
      const one = harness([card()], { _tag: "Skipped", reason: "off" });
      yield* one.summaries(W, "mail-trigger");
      const moved = card({
        version: 4,
        updatedAt: 9,
        workers: [{ ...card().workers[0]!, now: "tests 38/52" }],
      });
      const two = harness([moved], { _tag: "Skipped", reason: "off" });
      yield* two.summaries(W, "mail-trigger");
      expect(two.jobs[0]!.basis).toBe(one.jobs[0]!.basis);
      const checksFail = card({
        workers: [
          {
            ...card().workers[0]!,
            prs: [{ repo: "acme/api", number: 212, state: "open", checks: "failing" }],
          },
        ],
      });
      const three = harness([checksFail], { _tag: "Skipped", reason: "off" });
      yield* three.summaries(W, "mail-trigger");
      expect(three.jobs[0]!.basis).not.toBe(one.jobs[0]!.basis);
    }),
  );

  it.effect(
    "makes no call for a card that carries its version's summary, and none with helpers off",
    () =>
      Effect.gen(function* () {
        const carried = harness([card({ summary: { text: "Fine.", version: 3 } })], {
          _tag: "Skipped",
          reason: "off",
        });
        expect(yield* carried.summaries(W, "mail-trigger")).toEqual({ text: "Fine.", version: 3 });
        expect(carried.jobs).toEqual([]);
        const off = harness([card()], { _tag: "Skipped", reason: "off" });
        expect(yield* off.summaries(W, "mail-trigger")).toBeUndefined();
        expect(off.written).toEqual([]);
      }),
  );

  it("keeps one plain sentence only", () => {
    expect(validFeatureSummary("Endpoint in review, waiting on #88.")).toBe(
      "Endpoint in review, waiting on #88.",
    );
    expect(validFeatureSummary("Two. Sentences.")).toBeUndefined();
    expect(validFeatureSummary("**bold**")).toBeUndefined();
    expect(validFeatureSummary("x".repeat(201))).toBeUndefined();
  });
});
