import type { FeatureCard, FeatureCardWorker, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { calmCard, cardWorkerTone, stageLineShown } from "./card-tones";
import type { RailFacts } from "./rail-model";

const worker = (over: Partial<FeatureCardWorker> = {}): FeatureCardWorker => ({
  threadId: "t-worker" as ThreadId,
  title: "Idempotent refund webhooks",
  project: "api",
  state: "working",
  station: "working",
  now: "asks you",
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
  ...over,
});

const facts = (over: Partial<RailFacts> = {}): RailFacts => ({
  asking: new Set(),
  status: () => "idle",
  ...over,
});

describe("cardWorkerTone", () => {
  it("is amber for a worker that asks you, whatever station it stands at", () => {
    const asking = facts({ asking: new Set(["t-worker" as ThreadId]) });
    expect(cardWorkerTone(worker(), asking)).toBe("needs");
    expect(cardWorkerTone(worker({ station: "review" }), asking)).toBe("needs");
  });

  it("takes the tone every other view reads, when the workspace has one for it", () => {
    expect(cardWorkerTone(worker(), facts({ tones: { "t-worker": "waiting" } }))).toBe("waiting");
  });

  it("is done for an archived or merged worker and red for a failed one", () => {
    expect(cardWorkerTone(worker({ state: "archived" }), facts())).toBe("merged");
    expect(cardWorkerTone(worker({ state: "merged", station: "merged" }), facts())).toBe("merged");
    expect(cardWorkerTone(worker({ flag: "error" }), facts())).toBe("error");
  });

  it("reads the card alone outside an orchestrator's chat", () => {
    expect(cardWorkerTone(worker(), undefined)).toBe("working");
    expect(cardWorkerTone(worker({ state: "question" }), undefined)).toBe("needs");
    expect(cardWorkerTone(worker({ state: "merged" }), undefined)).toBe("merged");
  });
});

const card = (workers: FeatureCardWorker[], over: Partial<FeatureCard> = {}): FeatureCard => ({
  workspaceId: "w-1" as WorkspaceId,
  feature: "ui-ux-pass",
  station: "working",
  version: 1,
  workers,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const working = () => "working" as const;

describe("stageLineShown", () => {
  it("is left out while every worker is briefed or working: the lines under it say so", () => {
    expect(stageLineShown(card([worker()]))).toBe(false);
    expect(stageLineShown(card([worker({ station: "briefed" })], { station: "briefed" }))).toBe(
      false,
    );
  });

  it("shows once a worker is past working, or workers stand at different stations", () => {
    expect(stageLineShown(card([worker({ station: "checks" })], { station: "checks" }))).toBe(true);
    expect(stageLineShown(card([worker(), worker({ station: "review" })]))).toBe(true);
    expect(stageLineShown(card([worker(), worker({ station: "briefed" })]))).toBe(true);
  });
});

describe("calmCard", () => {
  it("is one worker at work with nothing else to say", () => {
    expect(calmCard(card([worker()]), working)).toBe(true);
  });

  it("grows back into a card for an ask, a failure, a wait, a PR, a stage, a held brief or company", () => {
    const one = card([worker()]);
    expect(calmCard(one, () => "needs")).toBe(false);
    expect(calmCard(one, () => "error")).toBe(false);
    expect(calmCard(one, () => "waiting")).toBe(false);
    expect(calmCard(card([worker({ prs: [{ repo: "acme/api", number: 7 }] })]), working)).toBe(
      false,
    );
    expect(calmCard(card([worker()], { stage: { current: "preview deployed" } }), working)).toBe(
      false,
    );
    expect(
      calmCard(
        card([worker()], { held: [{ id: "h", title: "Docs" }] } as unknown as Partial<FeatureCard>),
        working,
      ),
    ).toBe(false);
    expect(calmCard(card([worker(), worker()]), working)).toBe(false);
    expect(calmCard(card([worker({ station: "checks" })], { station: "checks" }), working)).toBe(
      false,
    );
    expect(calmCard(card([]), working)).toBe(false);
  });
});
