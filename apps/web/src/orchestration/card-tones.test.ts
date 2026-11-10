import type { FeatureCardWorker, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { cardWorkerTone } from "./card-tones";
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
