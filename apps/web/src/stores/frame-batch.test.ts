// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFrameBatch, nextFrame, type Schedule } from "./frame-batch";

/** A schedule the test runs by hand: `frame()` is the next frame. */
const manual = () => {
  let pending: (() => void) | undefined;
  const schedule: Schedule = (run) => {
    pending = run;
    return () => {
      if (pending === run) pending = undefined;
    };
  };
  return {
    schedule,
    scheduled: () => pending !== undefined,
    frame: () => {
      const run = pending;
      pending = undefined;
      run?.();
    },
  };
};

describe("createFrameBatch", () => {
  it("applies nothing until the frame, then everything in the order it came", () => {
    const frames = manual();
    const applied: number[] = [];
    const batch = createFrameBatch<number>((n) => applied.push(n), frames.schedule);
    for (let n = 0; n < 150; n++) batch.push(n);
    expect(applied).toEqual([]);
    frames.frame();
    expect(applied).toEqual(Array.from({ length: 150 }, (_, n) => n));
  });

  it("schedules one flush however many arrive, and none once flushed", () => {
    const schedule = vi.fn<Schedule>(() => () => {});
    const batch = createFrameBatch<number>(() => {}, schedule);
    batch.push(1);
    batch.push(2);
    expect(schedule).toHaveBeenCalledTimes(1);
    batch.flush();
    batch.push(3);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("flushes at once when asked, and cancels the frame it was waiting for", () => {
    const frames = manual();
    const applied: string[] = [];
    const batch = createFrameBatch<string>((s) => applied.push(s), frames.schedule);
    batch.push("a");
    batch.flush();
    expect(applied).toEqual(["a"]);
    expect(frames.scheduled()).toBe(false);
    frames.frame();
    expect(applied).toEqual(["a"]);
  });

  it("keeps what applying pushes for the next frame, behind what was queued", () => {
    const frames = manual();
    const applied: string[] = [];
    const batch = createFrameBatch<string>((s) => {
      applied.push(s);
      if (s === "a") batch.push("c");
    }, frames.schedule);
    batch.push("a");
    batch.push("b");
    frames.frame();
    expect(applied).toEqual(["a", "b"]);
    frames.frame();
    expect(applied).toEqual(["a", "b", "c"]);
  });

  it("goes on past an item that throws, dropping nothing else", () => {
    const frames = manual();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const applied: number[] = [];
    const batch = createFrameBatch<number>((n) => {
      if (n === 2) throw new Error("bad event");
      applied.push(n);
    }, frames.schedule);
    for (const n of [1, 2, 3]) batch.push(n);
    frames.frame();
    expect(applied).toEqual([1, 3]);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

/** A window whose frames never come and whose timers never run, as a hidden one's may not. */
const stalled = (visibility: DocumentVisibilityState) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let state = visibility;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return {
    hide: () => {
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
};
const ran = (run: { mock: { calls: unknown[] } }) =>
  vi.waitFor(() => expect(run.mock.calls).toHaveLength(1), { timeout: 1_000 });

describe("nextFrame", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs a hidden window's batch in a task of its own, waiting on no frame or timer", async () => {
    stalled("hidden");
    const run = vi.fn();
    nextFrame(run);
    await ran(run);
  });

  it("runs a batch at once when its window hides before the frame", async () => {
    const shown = stalled("visible");
    const run = vi.fn();
    nextFrame(run);
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(run).not.toHaveBeenCalled();
    shown.hide();
    await ran(run);
  });
});
