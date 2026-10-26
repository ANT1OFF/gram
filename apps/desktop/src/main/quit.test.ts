import { createSignalQuit } from "./signal-quit.ts";
import { describe, expect, it } from "vitest";

import {
  createQuit,
  QUIT_DEADLINE_MS,
  quitDetail,
  serverShutdownFromMessage,
  SHOW_PROGRESS_AFTER_MS,
  type QuitProgress,
  type QuitStep,
} from "./quit.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A step that resolves when the test says so. */
const pending = (name: string, timeoutMs = 5_000) => {
  const done = Promise.withResolvers<void>();
  let started = false;
  const step: QuitStep = {
    name,
    timeoutMs,
    run: () => {
      started = true;
      return done.promise;
    },
  };
  return { step, finish: () => done.resolve(), started: () => started };
};

/** The quit over fake timers and kills; no time passes by itself. */
const setup = (steps: ReadonlyArray<QuitStep>) => {
  const clock = { now: 0 };
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const exits: number[] = [];
  const shown: QuitProgress[] = [];
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  let terminated = 0;
  const quit = createQuit({
    steps,
    terminate: () => terminated++,
    exit: (code) => exits.push(code),
    onProgress: (progress) => shown.push(progress),
    log: {
      info: (fields, message) => lines.push({ level: "info", fields, message }),
      warn: (fields, message) => lines.push({ level: "warn", fields, message }),
    },
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
  /** Runs the live timer of `ms`, as if that much time had passed. */
  const fire = (ms: number) => {
    const timer = timers.find((t) => !t.cleared && t.ms === ms)!;
    timer.cleared = true;
    timer.callback();
  };
  return { quit, clock, exits, shown, lines, fire, terminated: () => terminated };
};

describe("quit", () => {
  it("runs its steps in order, logs what each took, and exits", async () => {
    const speech = pending("speech");
    const server = pending("server");
    const { quit, clock, exits, lines, terminated } = setup([speech.step, server.step]);
    quit.request();
    expect(quit.state()).toBe("stopping");
    expect(speech.started()).toBe(true);
    expect(server.started()).toBe(false);
    clock.now = 40;
    speech.finish();
    await flush();
    expect(server.started()).toBe(true);
    clock.now = 900;
    server.finish();
    await flush();
    expect(exits).toEqual([0]);
    expect(quit.state()).toBe("exited");
    expect(lines.map((line) => [line.message, line.fields])).toEqual([
      ["quit: started", { steps: ["speech", "server"] }],
      ["quit: step done", { step: "speech", ms: 40, outcome: "done" }],
      ["quit: step done", { step: "server", ms: 860, outcome: "done" }],
      ["quit: done", { ms: 900 }],
    ]);
    expect(terminated()).toBe(0);
  });

  it("goes on past a step that overruns its timeout or fails", async () => {
    const stuck = pending("speech", 3_000);
    const failing: QuitStep = {
      name: "server",
      timeoutMs: 5_000,
      run: () => Promise.reject(new Error("no")),
    };
    const { quit, exits, lines, fire } = setup([stuck.step, failing]);
    quit.request();
    fire(3_000);
    await flush();
    expect(lines[1]).toMatchObject({
      level: "warn",
      fields: { step: "speech", outcome: "timeout", timeoutMs: 3_000 },
    });
    expect(lines[2]).toMatchObject({
      level: "warn",
      fields: { step: "server", outcome: "failed" },
    });
    expect(exits).toEqual([0]);
  });

  it("shows its progress only once it has run a second, then on every change", async () => {
    const server = pending("server");
    const { quit, shown, fire } = setup([server.step]);
    quit.request();
    quit.report({ agents: 3, working: 1 });
    expect(shown).toEqual([]);
    fire(SHOW_PROGRESS_AFTER_MS);
    expect(shown).toEqual([{ step: "server", agents: 3, working: 1 }]);
    quit.report({ agents: 0, working: 1 });
    expect(shown.at(-1)).toEqual({ step: "server", agents: 0, working: 1 });
    server.finish();
    await flush();
    // Nothing more once it has exited.
    quit.report({ agents: 2, working: 0 });
    expect(shown).toHaveLength(2);
  });

  it("forces on a second request: kills what main started, then exits", async () => {
    const server = pending("server");
    const later = pending("after");
    const { quit, exits, lines, terminated } = setup([server.step, later.step]);
    quit.request();
    quit.request();
    expect(terminated()).toBe(1);
    expect(exits).toEqual([0]);
    expect(lines.at(-1)).toMatchObject({
      level: "warn",
      fields: { reason: "user", step: "forcing" },
      message: "quit: forced",
    });
    // The step it cut short finishing changes nothing.
    server.finish();
    await flush();
    expect(later.started()).toBe(false);
    expect(exits).toEqual([0]);
  });

  it("forces at the deadline", () => {
    const { quit, exits, fire, lines, terminated } = setup([pending("server").step]);
    quit.request();
    fire(QUIT_DEADLINE_MS);
    expect(terminated()).toBe(1);
    expect(exits).toEqual([0]);
    expect(lines.at(-1)).toMatchObject({ fields: { reason: "deadline" } });
  });

  it("does nothing on force or report before it has started", () => {
    const { quit, exits, terminated } = setup([]);
    quit.report({ agents: 1, working: 0 });
    quit.force("user");
    expect(terminated()).toBe(0);
    expect(exits).toEqual([]);
    expect(quit.state()).toBe("idle");
  });
});

describe("serverShutdownFromMessage", () => {
  it("reads the server's progress, and only that", () => {
    expect(
      serverShutdownFromMessage({ type: "shutdown", phase: "sessions", agents: 2, working: 1 }),
    ).toEqual({ agents: 2, working: 1 });
    expect(serverShutdownFromMessage({ type: "shutdown", agents: -1, working: 1.5 })).toEqual({
      agents: 0,
      working: 0,
    });
    expect(serverShutdownFromMessage({ type: "boot", url: "x" })).toBeNull();
    expect(serverShutdownFromMessage("shutdown")).toBeNull();
  });
});

describe("quitDetail", () => {
  it("says what is stopping and what is interrupted", () => {
    expect(quitDetail({ step: "server", agents: 3, working: 2 })).toBe(
      "Stopping 3 agents. 2 running threads are interrupted.",
    );
    expect(quitDetail({ step: "server", agents: 1, working: 1 })).toBe(
      "Stopping 1 agent. 1 running thread is interrupted.",
    );
    expect(quitDetail({ step: "speech", agents: 0, working: 0 })).toBe("Saving your threads…");
    expect(quitDetail({ step: "forcing", agents: 3, working: 2 })).toBe("Stopping everything now…");
  });
});

describe("service signal shutdown", () => {
  it("routes signals through ordinary quit once and never escalates a running stop", async () => {
    const stop = pending("server");
    const state = setup([stop.step]);
    let ordinaryRequests = 0;
    const signal = createSignalQuit(
      () => state.quit.state() === "idle",
      () => {
        ordinaryRequests++;
        state.quit.request();
      },
    );
    signal();
    signal();
    expect(ordinaryRequests).toBe(1);
    expect(state.terminated()).toBe(0);
    stop.finish();
    await flush();
    expect(state.exits).toEqual([0]);
  });
});
