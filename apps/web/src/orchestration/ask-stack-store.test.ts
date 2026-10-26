import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hiddenIds, SENT_GRACE_MS, UNDO_MS, useAskStackStore } from "./ask-stack-store";

const reset = () => useAskStackStore.setState({ held: [], sent: {}, problems: {}, replies: {} });

const hidden = () => [...hiddenIds(useAskStackStore.getState())].toSorted();

describe("the ask stack's held answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds an answer for the undo window, then sends it once and keeps its ids hidden", async () => {
    const send = vi.fn(async () => ({}));
    useAskStackStore.getState().hold({ key: "a,b", ids: ["a", "b"], done: "Allowed 2" }, send);
    expect(useAskStackStore.getState().held.map((h) => h.key)).toEqual(["a,b"]);
    expect(hidden()).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    // In flight: no longer undoable, still hidden.
    expect(useAskStackStore.getState().held).toEqual([]);
    expect(useAskStackStore.getState().undo("a,b")).toBeUndefined();
    expect(hidden()).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(SENT_GRACE_MS);
    expect(hidden()).toEqual([]);
  });

  it("takes back the newest held answer, and nothing is sent", async () => {
    const send = vi.fn(async () => ({}));
    const { hold, undo } = useAskStackStore.getState();
    hold({ key: "a", ids: ["a"], done: "Allowed" }, send);
    hold({ key: "b", ids: ["b"], done: "Denied" }, send);
    expect(undo()?.key).toBe("b");
    expect(undo("a")?.done).toBe("Allowed");
    expect(hidden()).toEqual([]);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it("brings back only the ids a send failed, with its problem beside them", async () => {
    useAskStackStore
      .getState()
      .hold({ key: "a,b", ids: ["a", "b"], done: "Allowed 2" }, async () => ({
        failed: ["b"],
        problem: "Answered 1 of 2",
      }));
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(hidden()).toEqual(["a"]);
    expect(useAskStackStore.getState().problems).toEqual({ b: "Answered 1 of 2" });
  });

  it("brings everything back when the send throws", async () => {
    useAskStackStore.getState().hold({ key: "a", ids: ["a"], done: "Allowed" }, async () => {
      throw new Error("offline");
    });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(hidden()).toEqual([]);
    expect(useAskStackStore.getState().problems).toEqual({ a: "offline" });
  });

  it("ignores a second hold of the same ask while one is pending", async () => {
    const send = vi.fn(async () => ({}));
    const { hold } = useAskStackStore.getState();
    hold({ key: "a", ids: ["a"], done: "Allowed" }, send);
    hold({ key: "a", ids: ["a"], done: "Denied" }, send);
    expect(useAskStackStore.getState().held.map((h) => h.done)).toEqual(["Allowed"]);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops a typed reply once its answer goes out", async () => {
    const { setReply, hold } = useAskStackStore.getState();
    setReply("q", "Say no packages yet");
    hold({ key: "q", ids: ["q"], done: "Replied" }, async () => ({}));
    expect(useAskStackStore.getState().replies).toEqual({ q: "Say no packages yet" });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(useAskStackStore.getState().replies).toEqual({});
  });
});
