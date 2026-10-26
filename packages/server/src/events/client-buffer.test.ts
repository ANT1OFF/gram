import { describe, expect, it } from "@effect/vitest";
import type { GitState, ServerEvent, ThreadId, WorkspaceId } from "@gram/contracts";
import { ClientBuffer, serverEventKey } from "./client-buffer.ts";

const t1 = "t1" as ThreadId;
const git = (head: string): ServerEvent => ({
  type: "git.state",
  threadId: t1,
  state: { head } as GitState,
});
const notify = (title: string): ServerEvent => ({ type: "notify", kind: "info", title });

describe("ClientBuffer", () => {
  it("keeps every event while under capacity", () => {
    const buffer = new ClientBuffer<ServerEvent>(10, serverEventKey);
    buffer.offer(git("a"));
    buffer.offer(notify("one"));
    buffer.offer(git("b"));
    expect(buffer.take()).toEqual({
      items: [git("a"), notify("one"), git("b")],
      overflowed: false,
    });
    expect(buffer.isEmpty).toBe(true);
  });

  it("under pressure keeps only each key's latest event, where it was offered", () => {
    const buffer = new ClientBuffer<ServerEvent>(3, serverEventKey);
    buffer.offer(notify("one"));
    buffer.offer(git("a"));
    buffer.offer(notify("two"));
    buffer.offer(git("b"));
    expect(buffer.take().items).toEqual([notify("one"), notify("two"), git("b")]);

    for (let i = 0; i < 1_000; i++) buffer.offer(git(String(i)));
    expect(buffer.take().items).toEqual([git("999")]);
  });

  it("clears when compaction can't make room, ignores offers until taken, then resumes", () => {
    const buffer = new ClientBuffer<ServerEvent>(3, serverEventKey);
    for (let i = 0; i < 4; i++) buffer.offer(notify(String(i)));
    buffer.offer(notify("late"));
    expect(buffer.isEmpty).toBe(false);
    expect(buffer.take()).toEqual({ items: [], overflowed: true });

    buffer.offer(notify("after"));
    expect(buffer.take()).toEqual({ items: [notify("after")], overflowed: false });
  });

  it("keys only full-state events, per thread", () => {
    expect(serverEventKey(git("a"))).toBe("git.state:t1");
    expect(serverEventKey({ type: "thread.status", threadId: t1, status: "idle" })).toBe(
      "thread.status:t1",
    );
    expect(serverEventKey({ type: "thread.ports", threadId: t1, ports: [3000] })).toBe(
      "thread.ports:t1",
    );
    // Each background shell's output keeps its own latest tail.
    expect(
      serverEventKey({
        type: "thread.backgroundOutput",
        threadId: t1,
        taskId: "b1",
        output: "ready",
      }),
    ).toBe("thread.backgroundOutput:t1:b1");
    expect(
      serverEventKey({ type: "orchestration.changed", workspaceId: "w1" as WorkspaceId }),
    ).toBe("orchestration.changed:w1");
    expect(serverEventKey({ type: "memory.changed", workspaceId: "w1" as WorkspaceId })).toBe(
      "memory.changed:w1",
    );
    expect(serverEventKey({ type: "outputs.changed", workspaceId: "w1" as WorkspaceId })).toBe(
      "outputs.changed:w1",
    );
    expect(serverEventKey({ type: "workspaces.changed" })).toBeUndefined();
    expect(serverEventKey(notify("x"))).toBeUndefined();
    expect(serverEventKey({ type: "thread.removed", threadId: t1 })).toBeUndefined();
  });
});
