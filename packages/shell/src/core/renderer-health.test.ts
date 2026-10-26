import { describe, expect, it } from "vitest";

import {
  createConnectionLog,
  FAILED_LOAD_RETRY_MS,
  parseRendererConnection,
  RELOAD_BUDGET,
  UNRESPONSIVE_PROMPT_MS,
  watchRenderer,
  type RendererEvents,
} from "./renderer-health.ts";

const setup = (answer = true) => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const contents = {
    on: (event: string, listener: (...args: never[]) => void) => handlers.set(event, listener),
  } as unknown as RendererEvents;
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const clock = { now: 0 };
  const calls = { reload: 0, crash: 0, offers: 0 };
  let alive = true;
  watchRenderer(contents, {
    windowId: "w1",
    log: {
      info: (fields, message) => lines.push({ level: "info", fields, message }),
      warn: (fields, message) => lines.push({ level: "warn", fields, message }),
      error: (fields, message) => lines.push({ level: "error", fields, message }),
    },
    reload: () => calls.reload++,
    crash: () => calls.crash++,
    offerReload: async () => {
      calls.offers++;
      return answer;
    },
    alive: () => alive,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer !== undefined) (timer as { cleared: boolean }).cleared = true;
    },
    now: () => clock.now,
  });
  const emit = (event: string, ...args: unknown[]) =>
    (handlers.get(event) as (...args: unknown[]) => void)(...args);
  const fire = (ms: number) => {
    const timer = timers.find((pending) => !pending.cleared && pending.ms === ms)!;
    timer.cleared = true;
    timer.callback();
  };
  return { emit, fire, lines, calls, clock, timers, close: () => (alive = false) };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watchRenderer", () => {
  it("logs a hang and how long it lasted, without offering a reload for a short one", () => {
    const { emit, lines, clock, timers, calls } = setup();
    emit("unresponsive");
    emit("unresponsive");
    clock.now = 4_000;
    emit("responsive");
    expect(lines.map((line) => line.message)).toEqual([
      "renderer unresponsive",
      "renderer responsive again",
    ]);
    expect(lines[1]!.fields).toEqual({ source: "renderer", window: "w1", hungMs: 4_000 });
    expect(timers.every((timer) => timer.cleared)).toBe(true);
    expect(calls.offers).toBe(0);
  });

  it("offers a reload for a long hang, and reloads the renderer it ends", async () => {
    const { emit, fire, calls, clock } = setup();
    emit("unresponsive");
    clock.now = UNRESPONSIVE_PROMPT_MS;
    fire(UNRESPONSIVE_PROMPT_MS);
    await flush();
    expect(calls).toEqual({ reload: 0, crash: 1, offers: 1 });
    emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    expect(calls.reload).toBe(1);
  });

  it("leaves a hung renderer alone when the user waits, or when it recovered meanwhile", async () => {
    const waiting = setup(false);
    waiting.emit("unresponsive");
    waiting.fire(UNRESPONSIVE_PROMPT_MS);
    await flush();
    expect(waiting.calls.crash).toBe(0);
  });

  it("reloads a renderer that died, within a budget, and not after a clean exit", () => {
    const { emit, calls, lines } = setup();
    emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    expect(calls.reload).toBe(0);
    for (let i = 0; i <= RELOAD_BUDGET; i++) {
      emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    }
    expect(calls.reload).toBe(RELOAD_BUDGET);
    expect(lines.at(-1)?.message).toBe("renderer keeps dying; not reloading it");
    expect(lines[0]!.fields).toEqual({
      source: "renderer",
      window: "w1",
      reason: "clean-exit",
      exitCode: 0,
    });
  });

  it("retries a main-frame load that failed, never logging its URL", () => {
    const { emit, fire, calls, lines } = setup();
    emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://x/?boot=secret", true);
    emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://x/?boot=secret", false);
    expect(lines).toEqual([]);
    emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://x/?boot=secret", true);
    fire(FAILED_LOAD_RETRY_MS);
    expect(calls.reload).toBe(1);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("drops a pending retry once a newer load has started", () => {
    const { emit, timers, calls } = setup();
    emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "", true);
    // The server came back and its recovery reloaded the window before the retry fell due.
    emit("did-start-loading");
    expect(timers.every((timer) => timer.cleared)).toBe(true);
    expect(calls.reload).toBe(0);
  });

  it("does nothing for a window that closed", () => {
    const { emit, calls, close } = setup();
    close();
    emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    expect(calls.reload).toBe(0);
  });
});

describe("createConnectionLog", () => {
  it("logs a drop, each new attempt and the recovery with how long it was down", () => {
    const lines: { message: string; fields: Record<string, unknown> }[] = [];
    const sink = (fields: Record<string, unknown>, message: string) =>
      lines.push({ fields, message });
    const clock = { now: 1_000 };
    const log = createConnectionLog({ info: sink, warn: sink, error: sink }, () => clock.now);
    log.report("w1", { status: "open" });
    log.report("w1", { status: "reconnecting", attempt: 1 });
    log.report("w1", { status: "reconnecting", attempt: 1 });
    clock.now = 4_000;
    log.report("w1", { status: "reconnecting", attempt: 2 });
    clock.now = 9_000;
    log.report("w1", { status: "open" });
    log.report("w2", { status: "expired" });
    expect(lines).toEqual([
      {
        message: "renderer lost its server connection",
        fields: { source: "renderer", window: "w1", attempt: 1 },
      },
      {
        message: "renderer reconnecting",
        fields: { source: "renderer", window: "w1", attempt: 2, downMs: 3_000 },
      },
      {
        message: "renderer connection restored",
        fields: { source: "renderer", window: "w1", downMs: 8_000, attempts: 2 },
      },
      { message: "renderer session expired", fields: { source: "renderer", window: "w2" } },
    ]);
  });

  it("accepts only the shape the renderer sends", () => {
    expect(parseRendererConnection({ status: "reconnecting", attempt: 3 })).toEqual({
      status: "reconnecting",
      attempt: 3,
    });
    expect(parseRendererConnection({ status: "open", attempt: "x" })).toEqual({ status: "open" });
    expect(parseRendererConnection({ status: "gone" })).toBeUndefined();
    expect(parseRendererConnection(null)).toBeUndefined();
  });
});
