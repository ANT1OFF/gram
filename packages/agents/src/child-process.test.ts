import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptChildSwitchStartup,
  beginChildShutdownCheck,
  endInputAndWait,
  isRunning,
  notOrderlyExits,
  ownAgentChild,
  protectChildForSwitch,
  runningOwnedAgents,
  spawnServe,
  stopChild,
  stopChildForSwitch,
  stopOwnedAgentsForUpdate,
} from "./child-process.ts";

const fakeChild = () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  return {
    child: child as unknown as ChildProcess,
    exit(code: number | null, signal: NodeJS.Signals | null) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    },
  };
};
afterEach(() => vi.useRealTimers());

describe.skipIf(process.platform === "win32")("owned-child shutdown observation", () => {
  it("a stale startup acceptance cannot release a cancelled owner's protection", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const kill = f.child.kill;
    const startup = protectChildForSwitch(f.child);
    const stop = stopChildForSwitch(f.child, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await stop).toBe(false);
    expect(acceptChildSwitchStartup(f.child, startup)).toBe(false);
    expect(f.child.kill("SIGKILL")).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    f.exit(null, "SIGTERM");
  });
  it("a switch requires actual EXIT, not signal acceptance", async () => {
    const f = fakeChild();
    const kill = f.child.kill;
    let finished = false;
    const stop = stopChildForSwitch(f.child).then((exited) => {
      finished = true;
      return exited;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    f.exit(null, "SIGTERM");
    expect(await stop).toBe(true);
  });

  it("a refused switch and its later cleanup never escalate", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const kill = f.child.kill;
    const stop = stopChildForSwitch(f.child, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await stop).toBe(false);
    const cleanup = stopChild(f.child, 10);
    f.child.kill("SIGKILL");
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    expect(f.child.listenerCount("exit")).toBe(1);
    f.exit(null, "SIGTERM");
    expect(f.child.kill).toBe(kill);
    expect(f.child.listenerCount("exit")).toBe(0);
  });

  it("accepted target startup restores ordinary cleanup behavior", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const kill = f.child.kill;
    const accept = protectChildForSwitch(f.child);
    expect(f.child.kill("SIGKILL")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    accept();
    const stop = stopChild(f.child, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    f.exit(null, "SIGKILL");
    await stop;
  });
  it("accepts a direct child that ends on the requested SIGTERM", async () => {
    const orderly = beginChildShutdownCheck(),
      f = fakeChild();
    const stop = stopChild(f.child);
    f.exit(null, "SIGTERM");
    await stop;
    expect(orderly()).toBe(true);
  });
  it("records a grace timeout and forced exit without breaking normal cleanup", async () => {
    vi.useFakeTimers();
    const orderly = beginChildShutdownCheck(),
      f = fakeChild();
    const stop = stopChild(f.child, 10);
    await vi.advanceTimersByTimeAsync(10);
    f.exit(null, "SIGKILL");
    await stop;
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(orderly()).toBe(false);
  });
  it("does not classify an unrequested SIGTERM as orderly cleanup", async () => {
    const orderly = beginChildShutdownCheck(),
      f = fakeChild();
    f.exit(null, "SIGTERM");
    await stopChild(f.child);
    expect(orderly()).toBe(false);
  });

  it("records an already crashed owned child", async () => {
    const orderly = beginChildShutdownCheck(),
      f = fakeChild();
    f.exit(3, null);
    await stopChild(f.child);
    expect(orderly()).toBe(false);
  });
});

/** A stand-in agent that ends on SIGTERM, or ignores it, and says when it is up. */
const idle = (onTerm: "exit" | "ignore") =>
  `process.on("SIGTERM", () => { ${onTerm === "exit" ? "process.exit(0)" : ""} }); setInterval(() => {}, 1e6); console.log("up")`;

/** A stand-in session CLI: SIGUSR1 exits 0, SIGUSR2 exits 3, anything else its default. */
const ending = `process.on("SIGUSR1", () => process.exit(0)); process.on("SIGUSR2", () => process.exit(3)); setInterval(() => {}, 1e6); console.log("up")`;

// Real child processes standing in for agents: node with an explicit, minimal environment.
describe.skipIf(process.platform === "win32")("owned agent stop for an update", () => {
  const env = { PATH: "/usr/bin:/bin" };
  const started: ChildProcess[] = [];
  const up = async (child: ChildProcess) => {
    started.push(child);
    await new Promise((resolve) => child.stdout!.once("data", resolve));
    return child;
  };
  afterEach(() => {
    for (const child of started.splice(0)) if (isRunning(child)) child.kill("SIGKILL");
  });

  it("stops a serve child through its normal stop and waits for a session child to end", async () => {
    const orderly = beginChildShutdownCheck();
    const serve = await up(spawnServe(process.execPath, ["-e", idle("exit")], env));
    const session = await up(
      spawn(process.execPath, ["-e", ending], { env, stdio: ["ignore", "pipe", "ignore"] }),
    );
    ownAgentChild(session, "session");
    expect(runningOwnedAgents()).toBe(2);
    // The session's own close ends its CLI, which exits 0; the update never signals it.
    setTimeout(() => session.kill("SIGUSR1"), 200);
    expect(await stopOwnedAgentsForUpdate(5_000)).toBe(0);
    expect(serve.signalCode ?? serve.exitCode).toBe(0);
    expect(session.exitCode).toBe(0);
    expect(orderly()).toBe(true);
  });

  it.each([
    ["exits 0 on its stdin closing", "SIGUSR1", true],
    // Unrequested or the SDK's escalation alike: a TERM proves no saved session.
    ["is ended by a bare SIGTERM", "SIGTERM", false],
    ["exits nonzero", "SIGUSR2", false],
    ["is killed with SIGKILL, the SDK's last resort", "SIGKILL", false],
    ["is ended by another signal", "SIGHUP", false],
  ] as const)("takes a session child that %s as orderly: %s", async (_case, signal, expected) => {
    const orderly = beginChildShutdownCheck();
    const session = await up(
      spawn(process.execPath, ["-e", ending], { env, stdio: ["ignore", "pipe", "ignore"] }),
    );
    ownAgentChild(session, "session");
    setTimeout(() => session.kill(signal), 50);
    expect(await stopOwnedAgentsForUpdate(5_000)).toBe(0);
    expect(orderly()).toBe(expected);
  });

  it.each([
    [
      "exits with the code its last result names (here 3)",
      "SIGUSR2",
      (): number | undefined => 3,
      true,
    ],
    ["exits other than its last result says", "SIGUSR2", (): number | undefined => 0, false],
    ["exits 0 while a turn is under way", "SIGUSR1", (): number | undefined => undefined, false],
    ["is ended by SIGTERM after a failed turn", "SIGTERM", (): number | undefined => 1, false],
  ] as const)(
    "takes a session child that %s as orderly only on its expected code",
    async (_case, signal, cleanExit, expected) => {
      const orderly = beginChildShutdownCheck();
      const session = await up(
        spawn(process.execPath, ["-e", ending], { env, stdio: ["ignore", "pipe", "ignore"] }),
      );
      ownAgentChild(session, "session", cleanExit);
      setTimeout(() => session.kill(signal), 50);
      expect(await stopOwnedAgentsForUpdate(5_000)).toBe(0);
      expect(orderly()).toBe(expected);
      expect(notOrderlyExits()).toEqual(
        expected
          ? []
          : [
              {
                kind: "session",
                code: session.exitCode,
                signal: session.signalCode,
                forced: false,
              },
            ],
      );
    },
  );

  it("ends a session child's input and waits for it to exit by itself, never signalling it", async () => {
    const session = await up(
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); console.log("up")`,
        ],
        { env, stdio: ["pipe", "pipe", "ignore"] },
      ),
    );
    const kill = vi.spyOn(session, "kill");
    expect(await endInputAndWait(session, 5_000)).toBe(true);
    expect(session.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("gives up on a session child that runs on past its input's end, leaving it running", async () => {
    const session = await up(
      spawn(process.execPath, ["-e", idle("ignore")], { env, stdio: ["pipe", "pipe", "ignore"] }),
    );
    expect(await endInputAndWait(session, 300)).toBe(false);
    expect(isRunning(session)).toBe(true);
  });

  it("reports a session child that doesn't end within the bound, without killing it", async () => {
    beginChildShutdownCheck();
    const session = await up(
      spawn(process.execPath, ["-e", idle("ignore")], { env, stdio: ["ignore", "pipe", "ignore"] }),
    );
    ownAgentChild(session, "session");
    expect(await stopOwnedAgentsForUpdate(300)).toBe(1);
    expect(isRunning(session)).toBe(true);
  });

  it("records a serve child that had to be forced as not orderly", async () => {
    const orderly = beginChildShutdownCheck();
    await up(spawnServe(process.execPath, ["-e", idle("ignore")], env));
    expect(await stopOwnedAgentsForUpdate(3_000, 200)).toBe(0);
    expect(orderly()).toBe(false);
  });
});
