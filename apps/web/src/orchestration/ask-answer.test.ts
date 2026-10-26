import type { ApprovalRequest, RequestId, ThreadId } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";

import { holdAnswer } from "./ask-answer";
import { askOf, asksOf } from "./ask-model";
import { hiddenIds, UNDO_MS, useAskStackStore } from "./ask-stack-store";
import { groupInbox, type InboxEntry } from "./inbox-model";

const push = (id: string): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "git push -u origin feat/mail-trigger" },
  suggestions: [],
});

const entry = (id: string): InboxEntry => ({
  threadId: `t-${id}` as ThreadId,
  title: id,
  feature: "mail",
  request: push(`r-${id}`),
});

beforeEach(() => {
  vi.useFakeTimers();
  useAskStackStore.setState({ held: [], sent: {}, problems: {}, replies: {}, focusKey: undefined });
});
afterEach(() => vi.useRealTimers());

describe("answering an ask from outside the stack", () => {
  it("goes through the stack's hold: hidden at once, sent once after undo time", async () => {
    const groups = groupInbox([entry("a"), entry("b"), entry("c")]);
    const ask = askOf(groups[0]!);
    const respondMany = vi.fn(async (answers: Parameters<Api["respondMany"]>[0]) =>
      answers.map((a) => ({ threadId: a.threadId, requestId: a.requestId, ok: true as const })),
    );
    const api = { respondMany } as unknown as Api;
    const allow = ask.options[0]!;
    if (allow.action.kind !== "group") throw new Error("not an Allow");

    holdAnswer(api, ask, allow.done, allow.action, () => {});

    // Gone from every view that reads the stack's asks, before anything is sent.
    const hidden = hiddenIds(useAskStackStore.getState());
    expect(asksOf({ groups, hidden })).toEqual([]);
    expect(useAskStackStore.getState().held.map((h) => h.done)).toEqual(["Allowed 3"]);
    expect(respondMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(respondMany).toHaveBeenCalledTimes(1);
    expect(respondMany.mock.calls[0]![0].map((a) => [a.requestId, a.answer])).toEqual(
      ["r-a", "r-b", "r-c"].map((id) => [
        id,
        { kind: "approval", decision: "allow", scope: "once" },
      ]),
    );
    expect(asksOf({ groups, hidden: hiddenIds(useAskStackStore.getState()) })).toEqual([]);
  });

  it("can still be taken back in the stack before it goes out", async () => {
    const groups = groupInbox([entry("a")]);
    const ask = askOf(groups[0]!);
    const respondMany = vi.fn();
    const allow = ask.options[0]!;
    if (allow.action.kind !== "group") throw new Error("not an Allow");
    holdAnswer({ respondMany } as unknown as Api, ask, allow.done, allow.action, () => {});
    expect(useAskStackStore.getState().undo()?.key).toBe(ask.key);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(respondMany).not.toHaveBeenCalled();
    expect(asksOf({ groups, hidden: hiddenIds(useAskStackStore.getState()) })).toHaveLength(1);
  });
});
