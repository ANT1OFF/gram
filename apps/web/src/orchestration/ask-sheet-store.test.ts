import type { PendingRequest, RequestId, ThreadId, WorkspaceId } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { askOf, memoryAskOf } from "./ask-model";
import { answersInSheet, openAskSheet, showAsk, useAskSheet } from "./ask-sheet-store";
import { useAskStackStore } from "./ask-stack-store";
import { fitsInPlace, IN_PLACE_CHARS, memoryQuestionCard } from "./question-card-model";
import { groupInbox } from "./inbox-model";
import type { MemoryQuestion } from "./memory-model";

const W = "w-1" as WorkspaceId;

const q = (text: string, more: Partial<MemoryQuestion> = {}): MemoryQuestion => ({
  id: undefined,
  text,
  detail: undefined,
  open: true,
  ...more,
});

const plan: PendingRequest = {
  kind: "plan",
  id: "r-plan" as RequestId,
  plan: "1. Add the queue.\n2. Wire the trigger.",
};

const askFor = (request: PendingRequest) => {
  const [group] = groupInbox([
    { threadId: "t-w" as ThreadId, title: "Worker", feature: "mail", request },
  ]);
  return askOf(group!);
};

afterEach(() => {
  useAskSheet.getState().close();
  useAskStackStore.getState().focus(undefined);
});

describe("the ask sheet", () => {
  it("answers in the sheet what must be read in full, and in the dock what one key answers", () => {
    expect(answersInSheet(askFor(plan))).toBe(true);
    const several = memoryAskOf(
      W,
      q("Which repos?", { options: [{ label: "api" }, { label: "web" }], multiSelect: true }),
    );
    expect(answersInSheet(several)).toBe(true);
    const one = memoryAskOf(W, q("Ship it?", { options: [{ label: "Yes" }, { label: "No" }] }));
    expect(answersInSheet(one)).toBe(false);
    // A question answered in words is answered in the dock's reply field.
    expect(answersInSheet(memoryAskOf(W, q("Why?")))).toBe(false);
  });

  it("turns the dock to the ask, and opens the sheet only for one read in full", () => {
    const one = memoryAskOf(W, q("Ship it?", { options: [{ label: "Yes" }, { label: "No" }] }));
    showAsk(W, one);
    expect(useAskStackStore.getState().focusKey).toBe(one.key);
    expect(useAskSheet.getState().target).toBeUndefined();
    const review = askFor(plan);
    showAsk(W, review);
    expect(useAskStackStore.getState().focusKey).toBe(review.key);
    expect(useAskSheet.getState().target).toEqual({ workspaceId: W, id: "r-plan" });
  });

  it("keeps a group's sheet by its first id, so a member joining doesn't close it", () => {
    openAskSheet(W, { ids: ["r-1", "r-2"], key: "r-1,r-2" });
    expect(useAskSheet.getState().target).toEqual({ workspaceId: W, id: "r-1" });
  });
});

const card = (options: number, text = "Retry after three?") =>
  memoryQuestionCard(
    q(text, {
      options: Array.from({ length: options }, (_, index) => ({ label: `Choice ${index + 1}` })),
    }),
  );

describe("a question answered in place", () => {
  it("fits in place with a few short choices", () => {
    expect(fitsInPlace(card(3))).toBe(true);
    expect(fitsInPlace(card(4))).toBe(true);
  });

  it("goes to the sheet with many choices or a long text", () => {
    expect(fitsInPlace(card(5))).toBe(false);
    expect(fitsInPlace(card(2, "x".repeat(IN_PLACE_CHARS + 1)))).toBe(false);
  });
});
