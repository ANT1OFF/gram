import type { FeatureCard, FeatureCardWorker, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { LABEL_WORD_CAP, labelWords, MENU_CAP } from "@/palette/menu-caps";

import { aboutFeature, featureMenuLabel, featureSheet, FEATURE_MENU } from "./feature-sheet-model";
import type { RailFacts } from "./rail-model";

const worker = (id: string, over: Partial<FeatureCardWorker> = {}): FeatureCardWorker => ({
  threadId: id as ThreadId,
  title: id,
  project: "api",
  state: "working",
  station: "working",
  now: "editing code",
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
  ...over,
});

const card = (workers: FeatureCardWorker[]): FeatureCard => ({
  workspaceId: "ws-1" as WorkspaceId,
  feature: "mail-trigger",
  station: "working",
  version: 3,
  workers,
  createdAt: 1,
  updatedAt: 1,
});

const facts = (asking: string[] = []): RailFacts => ({
  asking: new Set(asking as ThreadId[]),
  status: () => undefined,
});

const prOf = (number: number, state?: "open" | "merged") => ({
  repo: "example/api",
  number,
  ...(state === undefined ? {} : { state }),
});

describe("featureSheet", () => {
  const mail = card([
    worker("Schema", { station: "merged", state: "merged", prs: [prOf(209, "merged")] }),
    worker("Queue"),
    worker("Endpoint", { station: "review", state: "inReview", prs: [prOf(212, "open")] }),
    // The same PR under a second worker is listed once.
    worker("Form", { prs: [prOf(212, "open")] }),
    worker("Spike", { state: "archived" }),
  ]);

  it("counts the workers on each station, leaving archived ones out as the line does", () => {
    const sheet = featureSheet(mail, facts(["Queue"]))!;
    expect(sheet.counts).toEqual({ briefed: 0, working: 2, checks: 0, review: 1, merged: 1 });
    expect(sheet.workers.map((w) => w.threadId)).toEqual(["Queue", "Form", "Endpoint", "Schema"]);
    expect(sheet.row.reach).toBe(4);
    expect(sheet.needs).toBe(1);
  });

  it("lists each PR once, open ones before merged ones", () => {
    const sheet = featureSheet(mail, facts())!;
    expect(sheet.prs.map(({ pr, by }) => [pr.number, by])).toEqual([
      [212, "Endpoint"],
      [209, "Schema"],
    ]);
  });

  it("has no sheet once every worker is archived", () => {
    expect(featureSheet(card([worker("a", { state: "archived" })]), facts())).toBeUndefined();
  });

  it("starts a question with each worker's reference and the PRs, for the user to finish", () => {
    const sheet = featureSheet(mail, facts())!;
    expect(aboutFeature(sheet.row)).toBe(
      'About the feature mail-trigger: "Queue" [thread Queue] editing code; "Form" [thread Form] editing code; "Endpoint" [thread Endpoint] editing code; "Schema" [thread Schema] editing code. PRs: example/api#212, example/api#209 merged.\n\n',
    );
    const bare = featureSheet(card([worker("Queue")]), facts())!;
    expect(aboutFeature(bare.row)).toBe(
      'About the feature mail-trigger: "Queue" [thread Queue] editing code.\n\n',
    );
  });
});

describe("the feature menu", () => {
  it("keeps to the menu cap, each label a few words", () => {
    expect(FEATURE_MENU.length).toBeLessThanOrEqual(MENU_CAP);
    for (const label of FEATURE_MENU) {
      expect(labelWords(label), label).toBeLessThanOrEqual(LABEL_WORD_CAP);
    }
  });

  it("reads Open, Ask about it, Set stage…, Move to group, Pause, Rename, Archive", () => {
    expect(
      FEATURE_MENU.map((item) => featureMenuLabel(item, { paused: false, staged: false })),
    ).toEqual([
      "Open",
      "Ask about it",
      "Set stage…",
      "Move to group",
      "Pause",
      "Rename",
      "Archive",
    ]);
  });

  it("says Resume on a paused feature, and Edit plan… on one with a stage", () => {
    expect(
      FEATURE_MENU.map((item) => featureMenuLabel(item, { paused: true, staged: true })),
    ).toEqual([
      "Open",
      "Ask about it",
      "Edit plan…",
      "Move to group",
      "Resume",
      "Rename",
      "Archive",
    ]);
  });
});
