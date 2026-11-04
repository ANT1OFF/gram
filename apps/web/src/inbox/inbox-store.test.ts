import type { PendingRequest, RequestId, ThreadId, WorkspaceId } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { askOf, memoryAskOf } from "@/orchestration/ask-model";
import { groupInbox } from "@/orchestration/inbox-model";
import type { MemoryQuestion } from "@/orchestration/memory-model";
import type { NeedsYouItem } from "@/orchestration/needs-you-items";
import { resetDerivedAsks, useDerivedAsks } from "@/orchestration/needs-you-store";

import { answersInFull } from "./inbox-detail";
import { showInbox, showInboxAsk, toggleInbox, useInboxStore } from "./inbox-store";

const W = "w-1" as WorkspaceId;
const OTHER = "w-2" as WorkspaceId;

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

const item = (key: string, workspaceId: WorkspaceId | undefined): NeedsYouItem => ({
  key,
  ids: [key],
  kind: "question",
  title: key,
  where: "Worker",
  workspaceId,
  threadId: "t-w" as ThreadId,
  owned: true,
});

/** Lists `items` as the window's Needs you, as `NeedsYouSource` would derive them. */
const listed = (items: readonly NeedsYouItem[]) =>
  useDerivedAsks.setState({
    needsYou: {
      groups: [],
      sections: [{ key: "questions", label: "Questions", items }],
      items,
      later: [],
    },
  });

afterEach(() => {
  resetDerivedAsks();
  useInboxStore.setState({ open: false, selected: undefined, category: "all", later: false });
});

describe("the Inbox's detail", () => {
  it("reads in full what must be, and answers in place what one key answers", () => {
    expect(answersInFull(askFor(plan))).toBe(true);
    const several = memoryAskOf(
      W,
      q("Which repos?", { options: [{ label: "api" }, { label: "web" }], multiSelect: true }),
    );
    expect(answersInFull(several)).toBe(true);
    const one = memoryAskOf(W, q("Ship it?", { options: [{ label: "Yes" }, { label: "No" }] }));
    expect(answersInFull(one)).toBe(false);
    // A question answered in words is answered in the reply field in place.
    expect(answersInFull(memoryAskOf(W, q("Why?")))).toBe(false);
  });
});

describe("opening the Inbox", () => {
  it("opens on an ask by its key, every category shown", () => {
    const one = memoryAskOf(W, q("Ship it?", { options: [{ label: "Yes" }, { label: "No" }] }));
    listed([item("ask:other", W), item(`ask:${one.key}`, W)]);
    useInboxStore.setState({ category: "errors" });
    showInboxAsk(one.key);
    expect(useInboxStore.getState()).toMatchObject({
      open: true,
      selected: `ask:${one.key}`,
      category: "all",
    });
  });

  it("opens on a workspace's first item, and where it was left for one with none", () => {
    listed([item("a", OTHER), item("b", W), item("c", W)]);
    showInbox({ workspaceId: W });
    expect(useInboxStore.getState().selected).toBe("b");
    useInboxStore.setState({ open: false, selected: "c" });
    showInbox({ workspaceId: "w-none" as WorkspaceId });
    expect(useInboxStore.getState()).toMatchObject({ open: true, selected: "c" });
  });

  it("toggles from the title bar, the pill and its keys", () => {
    toggleInbox();
    expect(useInboxStore.getState().open).toBe(true);
    toggleInbox();
    expect(useInboxStore.getState().open).toBe(false);
  });
});
