import { describe, expect, it } from "vitest";
import type { GitState } from "./git.ts";
import type { TurnId } from "./ids.ts";
import type { GramUIMessage } from "./ui-message.ts";
import { latestWrapUp, liveWrapUpButtons, wrapUpActionsFor, type WrapUpData } from "./wrap-up.ts";

const box = (turnId: string, recap = "Done."): WrapUpData => ({
  id: `wrap-up:${turnId}`,
  turnId: turnId as TurnId,
  recap,
  actions: [],
  at: 0,
});

const user = (id: string): GramUIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: "go" }] }) as GramUIMessage;

const reply = (id: string, data?: WrapUpData, parentToolUseId?: string): GramUIMessage =>
  ({
    id,
    role: "assistant",
    ...(parentToolUseId === undefined ? {} : { metadata: { parentToolUseId } }),
    parts: [
      { type: "text", text: "working" },
      ...(data === undefined ? [] : [{ type: "data-wrap-up", id: data.id, data }]),
      { type: "text", text: "closing" },
    ],
  }) as GramUIMessage;

const turn = (id: string, message: GramUIMessage): GramUIMessage => ({
  ...message,
  metadata: { turnId: id as TurnId },
});

const git: GitState = {
  repo: true,
  branch: "feat/x",
  worktree: true,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 1,
  conflicts: false,
  origin: "someone/repo",
};

describe("latestWrapUp", () => {
  it("finds the latest turn's box, the last one when it was called twice", () => {
    const first = box("t2", "First.");
    const second = box("t2", "Second.");
    const messages = [user("u1"), reply("a1", box("t1")), user("u2"), reply("a2", first)];
    expect(latestWrapUp(messages)).toBe(first);
    expect(latestWrapUp([...messages, reply("a3", second)])).toBe(second);
    expect(latestWrapUp(messages, "t2" as TurnId)).toBe(first);
    expect(latestWrapUp(messages, "t1" as TurnId)).toBeUndefined();
  });

  it("has none once a turn the agent started on its own has replied after it", () => {
    const own = box("t1");
    const messages = [user("u1"), turn("t1", reply("a1", own))];
    expect(latestWrapUp(messages)).toBe(own);
    expect(latestWrapUp([...messages, turn("t1", reply("a2"))])).toBe(own);
    expect(latestWrapUp([...messages, turn("t2", reply("a2"))])).toBeUndefined();
  });

  it("has none once the user has sent something after it, or in a subagent's transcript", () => {
    expect(latestWrapUp([user("u1"), reply("a1", box("t1")), user("u2")])).toBeUndefined();
    expect(latestWrapUp([user("u1"), reply("a1"), reply("s1", box("t1"), "tool-1")])).toBe(
      undefined,
    );
  });
});

describe("wrap-up app actions", () => {
  it("offers what the thread's header would", () => {
    expect(wrapUpActionsFor(undefined)).toEqual([]);
    // Never published: push it, and a PR can be opened.
    expect(wrapUpActionsFor(git)).toEqual(["push", "create_pr"]);
    expect(wrapUpActionsFor({ ...git, upstream: "synced" })).toEqual(["create_pr"]);
    const pr = { number: 3, state: "OPEN", isDraft: false } as NonNullable<GitState["pr"]>;
    expect(wrapUpActionsFor({ ...git, upstream: "synced", pr })).toEqual(["merge"]);
    expect(wrapUpActionsFor({ ...git, upstream: "synced", pr: { ...pr, isDraft: true } })).toEqual(
      [],
    );
    expect(
      wrapUpActionsFor({ ...git, upstream: "synced", pr: { ...pr, state: "MERGED" } }),
    ).toEqual([]);
  });

  it("drops a button whose control has nothing left to do, and keeps replies", () => {
    const actions = [
      { kind: "app", action: "push" },
      { kind: "reply", label: "Later", message: "Later" },
    ] as const;
    expect(liveWrapUpButtons({ actions }, git)).toEqual(actions);
    expect(liveWrapUpButtons({ actions }, { ...git, upstream: "synced" })).toEqual([actions[1]]);
  });
});
