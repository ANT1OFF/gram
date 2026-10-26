import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import type { UpdateProgress } from "@gram/contracts";
import { createUpdateService } from "@gram/shell/modules/update";
import { stopForUpdate, UpdateTeardownRefused } from "./update/shutdown.ts";

import {
  createServerHost,
  DEFAULT_RECOVERY,
  essentialsFromMessage,
  NO_RECOVERY,
  restartDelay,
  SHUTDOWN_REQUEST,
  UPDATE_SHUTDOWN_REQUEST,
  type HealthCheck,
  type RecoveryPolicy,
  type ServerChild,
  type ServerExit,
  type TreeCheck,
} from "./server-host.ts";

const BOOT = "http://127.0.0.1:51041/?boot=c4b154241fdbc8678cdca7eeaa9f1c5e";
const BOOT_2 = "http://127.0.0.1:51042/?boot=0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let nextPid = 1000;

const fakeChild = () => {
  const posted: unknown[] = [];
  const listeners: { message?: (message: unknown) => void; exit?: (code: number) => void } = {};
  let kills = 0;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ServerChild = {
    pid: nextPid++,
    stdout,
    stderr,
    on: ((event: "message" | "exit", listener: never) => {
      listeners[event] = listener;
    }) as ServerChild["on"],
    postMessage: (message) => posted.push(message),
    kill: () => {
      kills++;
      return true;
    },
  };
  return {
    child,
    posted,
    stdout,
    stderr,
    send: (message: unknown) => listeners.message?.(message),
    boot: (url = BOOT) => listeners.message?.({ type: "boot", url }),
    exit: (code: number) => listeners.exit?.(code),
    kills: () => kills,
  };
};

type FakeChild = ReturnType<typeof fakeChild>;

/** The host over fake children and timers; nothing is forked and no time passes by itself. */
const setup = (
  options: {
    bootFromStdout?: boolean;
    bootTimeoutMs?: number;
    recovery?: RecoveryPolicy;
    health?: HealthCheck;
    treeCheck?: TreeCheck;
  } = {},
) => {
  const children: FakeChild[] = [];
  const forceKilled: number[] = [];
  const clock = { now: 0 };
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const lines: { level: string; fields: unknown; message: string }[] = [];
  const messages: unknown[] = [];
  const host = createServerHost({
    fork: () => {
      const child = fakeChild();
      children.push(child);
      return child.child;
    },
    bootFromStdout: options.bootFromStdout ?? false,
    onMessage: (message, reply) => {
      messages.push(message);
      if ((message as { type?: string }).type === "ping") reply({ type: "pong" });
    },
    forceKill: (pid) => {
      forceKilled.push(pid);
      return { under: 2, names: ["zsh", "git"] };
    },
    log: {
      info: (fields, message) => lines.push({ level: "info", fields, message }),
      warn: (fields, message) => lines.push({ level: "warn", fields, message }),
      error: (fields, message) => lines.push({ level: "error", fields, message }),
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
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.treeCheck === undefined ? {} : { treeCheck: options.treeCheck }),
  });
  const exits: ServerExit[] = [];
  const recovered: string[] = [];
  const gaveUp: string[] = [];
  host.onUnexpectedExit((exit) => exits.push(exit));
  host.onRecovered((url) => recovered.push(url));
  host.onGiveUp((reason) => gaveUp.push(reason));
  const live = () => timers.filter((timer) => !timer.cleared);
  /** Runs the one pending timer that isn't the boot timeout, the restart's backoff. */
  const backoff = () => {
    const pending = live().filter((timer) => timer.ms !== 120_000);
    expect(pending).toHaveLength(1);
    pending[0]!.cleared = true;
    pending[0]!.callback();
    return pending[0]!.ms;
  };
  /** Runs the pending timer of `ms`, as if that much time had passed. */
  const fire = (ms: number) => {
    const timer = live().find((pending) => pending.ms === ms)!;
    timer.cleared = true;
    timer.callback();
  };
  /** Starts the host and boots its first child. */
  const booted = async () => {
    const boot = host.start();
    children[0]!.boot();
    await boot;
  };
  const latest = () => children.at(-1)!;
  return {
    host,
    children,
    timers,
    live,
    lines,
    messages,
    exits,
    recovered,
    gaveUp,
    forceKilled,
    clock,
    backoff,
    fire,
    booted,
    latest,
  };
};

/** A health check whose pings answer when told to. */
const pinging = () => {
  const pings: { url: string; answer: () => void; miss: () => void }[] = [];
  const health: HealthCheck = {
    ping: (url) =>
      new Promise<void>((resolve, reject) => {
        pings.push({ url, answer: resolve, miss: () => reject(new Error("timeout")) });
      }),
    intervalMs: 15_000,
    timeoutMs: 10_000,
    hungMs: 60_000,
  };
  return { pings, health };
};

const SEALED = { type: "shutdownEssentials", success: true, waitingOn: { TCPSocketWrap: 1 } };
/**
 * A tree check that records its calls: `found` is what `survivors` counts; `unread` has no watch
 * (no table), `unsettled` a freeze that can't settle.
 */
const tree = (found: number | undefined, watch: "read" | "unread" | "unsettled" = "read") => {
  const calls: string[] = [];
  const check: TreeCheck = {
    watch: (root) => {
      calls.push(`watch ${root}`);
      if (watch === "unread") return undefined;
      return {
        freeze: async () => {
          calls.push("freeze");
          return watch === "read";
        },
        survivors: async () => {
          calls.push("survivors");
          return found;
        },
      };
    },
  };
  return { calls, check };
};

describe("createServerHost", () => {
  it("boots from the server's boot message and remembers the URL", async () => {
    const { host, children } = setup();
    expect(host.state()).toBe("idle");
    const boot = host.start();
    expect(host.state()).toBe("booting");
    children[0]!.boot();
    expect(await boot).toBe(BOOT);
    expect(host.state()).toBe("running");
    expect(host.url()).toBe(BOOT);
  });

  it("forks one child however often it is started", async () => {
    const { host, children } = setup();
    const first = host.start();
    const second = host.start();
    expect(children).toHaveLength(1);
    children[0]!.boot();
    expect(await first).toBe(BOOT);
    expect(await second).toBe(BOOT);
    expect(await host.start()).toBe(BOOT);
    expect(children).toHaveLength(1);
  });

  it("relays messages to main and replies to the child that sent them", async () => {
    const { host, children, messages } = setup();
    void host.start();
    children[0]!.send({ type: "ping" });
    expect(messages).toEqual([{ type: "ping" }]);
    expect(children[0]!.posted).toEqual([{ type: "pong" }]);
    host.post({ type: "power", state: "suspend" });
    expect(children[0]!.posted.at(-1)).toEqual({ type: "power", state: "suspend" });
  });

  it("logs output but never a boot line, and takes stdout boot only when allowed", async () => {
    const packaged = setup();
    void packaged.host.start();
    packaged.children[0]!.stdout.write(`boot ${BOOT}\nmigrations applied\n`);
    packaged.children[0]!.stderr.write("deprecated\n");
    await flush();
    expect(packaged.host.state()).toBe("booting");
    expect(packaged.lines).toEqual([
      { level: "info", fields: { source: "server" }, message: "migrations applied" },
      { level: "warn", fields: { source: "server" }, message: "deprecated" },
    ]);

    const dev = setup({ bootFromStdout: true });
    const boot = dev.host.start();
    dev.children[0]!.stdout.write(`boot ${BOOT}\n`);
    expect(await boot).toBe(BOOT);
    expect(JSON.stringify(dev.lines)).not.toContain("boot=");
  });

  it("rejects the boot when the server exits before booting, and doesn't restart it", async () => {
    const { host, children, exits, live } = setup();
    const boot = host.start();
    children[0]!.exit(3);
    await expect(boot).rejects.toThrow("server exited with code 3 before booting");
    expect(host.state()).toBe("crashed");
    expect(exits).toEqual([{ code: 3, booted: false }]);
    expect(live()).toEqual([]);
    expect(children).toHaveLength(1);
  });

  it("reports an exit after boot, and without recovery starts afresh only when asked", async () => {
    const { host, children, exits, live, booted } = setup({ recovery: NO_RECOVERY });
    await booted();
    children[0]!.exit(1);
    expect(host.state()).toBe("crashed");
    expect(exits).toEqual([{ code: 1, booted: true }]);
    expect(live()).toEqual([]);

    const again = host.start();
    expect(children).toHaveLength(2);
    children[1]!.boot(BOOT_2);
    expect(await again).toBe(BOOT_2);
    expect(host.url()).toBe(BOOT_2);
  });

  it("stops the server, waiting for its exit, and doesn't report that exit", async () => {
    const { host, children, exits, live, booted } = setup();
    await booted();
    let stopped = false;
    const stop = host.stop("update").then((outcome) => {
      stopped = true;
      return outcome;
    });
    // Asked by message, since a signal would give it two seconds at most.
    expect(children[0]!.posted).toEqual([{ type: "shutdown" }]);
    expect(children[0]!.kills()).toBe(0);
    expect(host.state()).toBe("stopping");
    expect(host.stopReason()).toBe("update");
    await flush();
    expect(stopped).toBe(false);
    children[0]!.send({ type: "shutdownComplete", success: true });
    children[0]!.exit(0);
    expect(await stop).toBe("exited");
    expect(host.state()).toBe("stopped");
    expect(exits).toEqual([]);
    expect(live()).toEqual([]);
    expect(children).toHaveLength(1);
  });

  it.each([0, 3, 137])(
    "refuses update shutdown without completed teardown (exit %s)",
    async (code) => {
      const { host, children, booted } = setup();
      await booted();
      const stop = host.stop("update");
      children[0]!.exit(code);
      expect(await stop).not.toBe("exited");
    },
  );

  it.each([0, 1, 137])(
    "restores the updater UI without installer launch on unattested exit %s",
    async (code) => {
      const { host, children, booted } = setup();
      await booted();
      const calls: string[] = [];
      const progress: UpdateProgress[] = [];
      const service = createUpdateService({
        updater: {
          canSelfInstall: true,
          check: async () => ({ available: false, currentVersion: "1.0.0", canSelfInstall: true }),
          downloadAndVerify: async () => "unused-test-path",
        },
        stopServer: () => stopForUpdate(host),
        restartServer: async () => {
          calls.push("restart server");
        },
        broadcast: (value) => progress.push(value),
        hideWindows: () => {
          calls.push("hide");
          return () => {
            calls.push("show");
          };
        },
        spawnInstaller: async () => {
          calls.push("installer");
        },
        exit: () => {
          calls.push("exit");
        },
      });
      const installing = service.install({ channel: "stable", tag: "v1.1.0", downgrade: false });
      await flush();
      children[0]!.exit(code);
      const result = await installing;
      expect(result.updating).toBe(false);
      if (result.updating) throw new Error("Failed shutdown must refuse installation");
      expect(result.error).toContain("Update cancelled before app replacement.");
      expect(result.error).toContain("Gram remains on the running version.");
      expect(result.error).not.toContain("failed to launch installer");
      expect(progress.at(-1)).toEqual({ stage: "failed", tag: "v1.1.0", error: result.error });
      expect(calls).toEqual(["hide", "restart server", "show"]);
    },
  );

  it("does not accept progress, incomplete or pre-request teardown messages as attestation", async () => {
    const { host, children, booted } = setup();
    await booted();
    children[0]!.send({ type: "shutdownComplete", success: true });
    const stop = host.stop("update");
    children[0]!.send({ type: "shutdown", phase: "teardown", agents: 0, working: 0 });
    children[0]!.send({ type: "shutdownComplete", success: false });
    children[0]!.exit(0);
    expect(await stop).toBe("unconfirmed");
  });

  it("refuses a crashed or forcibly terminated update even with a completion message", async () => {
    for (const forced of [false, true]) {
      const { host, children, booted } = setup();
      await booted();
      const stop = host.stop("update");
      children[0]!.send({ type: "shutdownComplete", success: true });
      if (forced) host.terminate("quit");
      children[0]!.exit(forced ? 137 : 3);
      expect(await stop).not.toBe("exited");
    }
  });

  it("reports a stop that runs over its bound and kills the server outright", async () => {
    const { host, children, live, lines, forceKilled, booted } = setup();
    await booted();
    const stop = host.stop("update");
    expect(live().map((timer) => timer.ms)).toEqual([10_000]);
    live()[0]!.callback();
    await flush();
    expect(forceKilled).toEqual([children[0]!.child.pid]);
    expect(lines.at(-1)).toMatchObject({
      level: "warn",
      fields: { reason: "update", timeoutMs: 10_000 },
      message: "server didn't exit in time after being asked to stop; killing it",
    });
    children[0]!.exit(137);
    expect(await stop).toBe("forced");
    expect(host.state()).toBe("stopped");

    // One that survives even that is reported, and the stop still ends.
    const other = setup();
    await other.booted();
    const stuck = other.host.stop("quit");
    other.live()[0]!.callback();
    await flush();
    other.live()[0]!.callback();
    expect(await stuck).toBe("lingering");
    expect(other.lines.at(-1)).toMatchObject({ level: "error" });
    // A late exit from the child it stopped changes nothing.
    other.children[0]!.exit(0);
    expect(other.host.state()).toBe("stopped");
    expect(other.live()).toEqual([]);
  });

  describe("update essentials fence", () => {
    it("asks a quit's server for no seal and keeps its stop as it was", async () => {
      const { check, calls } = tree(0);
      const { host, children, live, forceKilled, booted } = setup({ treeCheck: check });
      await booted();
      const stop = host.stop("quit");
      expect(children[0]!.posted).toEqual([SHUTDOWN_REQUEST]);
      // A seal reported anyway changes nothing for a quit: it still waits out its bound.
      children[0]!.send(SEALED);
      await flush();
      expect(forceKilled).toEqual([]);
      live()[0]!.callback();
      await flush();
      children[0]!.exit(137);
      expect(await stop).toBe("forced");
      expect(host.updateStop()).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("watches from the request, freezes before the kill and proves the tree gone after", async () => {
      const { check, calls } = tree(0);
      const { host, children, forceKilled, lines, booted } = setup({ treeCheck: check });
      await booted();
      const pid = children[0]!.child.pid!;
      const stop = host.stop("update");
      expect(children[0]!.posted).toEqual([UPDATE_SHUTDOWN_REQUEST]);
      expect(calls).toEqual([`watch ${pid}`]);
      children[0]!.send(SEALED);
      await flush();
      expect(calls).toEqual([`watch ${pid}`, "freeze"]);
      expect(forceKilled).toEqual([pid]);
      expect(lines.at(-1)).toMatchObject({
        level: "warn",
        fields: { reason: "update", waitingOn: { TCPSocketWrap: 1 } },
        message: "server sealed its update essentials; killing the rest of its teardown",
      });
      children[0]!.exit(137);
      expect(await stop).toBe("essentials");
      expect(calls).toEqual([`watch ${pid}`, "freeze", "survivors"]);
      expect(host.updateStop()).toEqual({
        outcome: "essentials",
        waitingOn: { TCPSocketWrap: 1 },
        killed: { under: 2, names: ["zsh", "git"] },
        survivors: 0,
      });
      const stopped: unknown[] = [];
      await stopForUpdate(
        { stop: async () => "essentials", updateStop: () => host.updateStop() },
        (teardown) => stopped.push(teardown),
      );
      expect(stopped).toEqual([
        {
          path: "forced",
          killed: 2,
          names: ["zsh", "git"],
          waitingOn: { TCPSocketWrap: 1 },
        },
      ]);
    });

    it("takes a seal that came before the bound ran out even when the exit didn't", async () => {
      const { host, children, live, forceKilled, booted } = setup({ treeCheck: tree(0).check });
      await booted();
      const stop = host.stop("update");
      // Reported as the bound ran out: the timeout wins the race, the seal still counts.
      live()[0]!.callback();
      children[0]!.send(SEALED);
      await flush();
      expect(forceKilled).toEqual([children[0]!.child.pid]);
      children[0]!.exit(137);
      expect(await stop).toBe("essentials");
    });

    it.each([
      ["a survivor", tree(1), "survived"],
      ["an unreadable table after the kill", tree(undefined), "unverified"],
      ["no table at the request", tree(0, "unread"), "unverified"],
      ["a freeze that can't settle, whatever is counted after", tree(0, "unsettled"), "unverified"],
    ] as const)("refuses after the kill for %s", async (_case, { check }, outcome) => {
      const { host, children, lines, booted } = setup({ treeCheck: check });
      await booted();
      const stop = host.stop("update");
      children[0]!.send(SEALED);
      await flush();
      children[0]!.exit(137);
      expect(await stop).toBe(outcome);
      expect(lines.at(-1)).toMatchObject({ level: "error" });
      await expect(
        stopForUpdate({ stop: async () => outcome, updateStop: () => host.updateStop() }),
      ).rejects.toThrow(/Update cancelled before app replacement\..*Gram remains on the running/);
    });

    it("refuses a seal without a tree check, and one whose server outlives the kill", async () => {
      const unchecked = setup();
      await unchecked.booted();
      const stop = unchecked.host.stop("update");
      // Not asked to seal: without a check of the kill, an update is as strict as before.
      expect(unchecked.children[0]!.posted).toEqual([SHUTDOWN_REQUEST]);
      unchecked.children[0]!.send(SEALED);
      await flush();
      unchecked.children[0]!.exit(137);
      expect(await stop).toBe("unverified");

      const { check, calls } = tree(0);
      const stuck = setup({ treeCheck: check });
      await stuck.booted();
      const stuckStop = stuck.host.stop("update");
      stuck.children[0]!.send(SEALED);
      await flush();
      stuck
        .live()
        .find((timer) => timer.ms === 2_000)!
        .callback();
      expect(await stuckStop).toBe("lingering");
      // Still counted, so what is left of the tree is killed rather than left stopped.
      expect(calls).toEqual([`watch ${stuck.children[0]!.child.pid}`, "freeze", "survivors"]);
    });

    it("names the essential a teardown that ended before the seal reports, then exited 0", async () => {
      const { check } = tree(0);
      const { host, children, forceKilled, booted } = setup({ treeCheck: check });
      await booted();
      const stop = host.stop("update");
      // rc.14 at 09:38:57Z: the whole teardown ended in 2.5 s with an agent not orderly.
      children[0]!.send({ type: "shutdownEssentials", success: false, failed: "agents" });
      children[0]!.exit(0);
      expect(await stop).toBe("unconfirmed");
      expect(forceKilled).toEqual([]);
      expect(host.updateStop()).toEqual({ outcome: "unconfirmed", failed: "agents" });
      const refused = (await stopForUpdate({
        stop: async () => "unconfirmed",
        updateStop: () => host.updateStop(),
      }).catch((error: unknown) => error)) as UpdateTeardownRefused;
      expect(refused).toBeInstanceOf(UpdateTeardownRefused);
      expect(refused.message).toBe(
        "Update cancelled before app replacement. An agent process (a Claude Code session or the Codex app-server) did not exit cleanly when stopped. Gram remains on the running version. Check shutdown diagnostics before retrying.",
      );
      expect(refused.teardown).toEqual({ path: "refused", reason: "agents" });
    });

    it("refuses on a failed essential, waiting out the bound as before, and names it", async () => {
      const { check, calls } = tree(0);
      const { host, children, live, forceKilled, booted } = setup({ treeCheck: check });
      await booted();
      const stop = host.stop("update");
      children[0]!.send({ type: "shutdownEssentials", success: false, failed: "agents" });
      await flush();
      expect(forceKilled).toEqual([]);
      live()[0]!.callback();
      await flush();
      children[0]!.exit(137);
      expect(await stop).toBe("forced");
      expect(calls).toEqual([`watch ${children[0]!.child.pid}`]);
      expect(host.updateStop()).toEqual({ outcome: "forced", failed: "agents" });
      await expect(
        stopForUpdate({ stop: async () => "forced", updateStop: () => host.updateStop() }),
      ).rejects.toThrow(
        "Update cancelled before app replacement. An agent process (a Claude Code session or the Codex app-server) did not exit cleanly when stopped.",
      );
    });

    it("keeps the clean path when the whole teardown finishes, a seal notwithstanding", async () => {
      const { check, calls } = tree(0);
      const { host, children, booted } = setup({ treeCheck: check });
      await booted();
      const stop = host.stop("update");
      children[0]!.send({ type: "shutdownComplete", success: true });
      children[0]!.exit(0);
      expect(await stop).toBe("exited");
      expect(calls).toEqual([`watch ${children[0]!.child.pid}`]);
      expect(host.updateStop()).toEqual({ outcome: "exited" });
    });

    it("ignores a seal before the request, and malformed or unbounded reports", async () => {
      const { check, calls } = tree(0);
      const { host, children, live, forceKilled, booted } = setup({ treeCheck: check });
      await booted();
      children[0]!.send(SEALED);
      const stop = host.stop("update");
      children[0]!.send({ type: "shutdownEssentials", success: false, failed: "terminals" });
      children[0]!.send({ type: "shutdownEssentials", success: "yes" });
      await flush();
      expect(forceKilled).toEqual([]);
      live()[0]!.callback();
      await flush();
      children[0]!.exit(137);
      expect(await stop).toBe("forced");
      expect(calls).toEqual([`watch ${children[0]!.child.pid}`]);
      expect(
        essentialsFromMessage({
          type: "shutdownEssentials",
          success: true,
          waitingOn: {
            TCPSocketWrap: 2,
            "/Users/someone/repo": 1,
            Timeout: -1,
            ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Kind${i}`, 1])),
          },
        }),
      ).toEqual({
        waitingOn: {
          TCPSocketWrap: 2,
          ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`Kind${i}`, 1])),
        },
      });
    });
  });

  it("terminates the server a stop is waiting on, by its pid", async () => {
    const { host, children, forceKilled, booted } = setup();
    await booted();
    const stop = host.stop("quit");
    host.terminate("quit");
    expect(forceKilled).toEqual([children[0]!.child.pid]);
    children[0]!.exit(137);
    expect(await stop).toBe("exited");
    expect(host.state()).toBe("stopped");
    // With nothing running there is nothing to kill.
    host.terminate("quit");
    expect(forceKilled).toHaveLength(1);
  });

  it("kills without waiting, and a kill while booting rejects the boot", async () => {
    const { host, children, exits } = setup();
    const boot = host.start();
    host.kill("smoke");
    expect(children[0]!.kills()).toBe(1);
    expect(host.state()).toBe("stopped");
    expect(host.stopReason()).toBe("smoke");
    children[0]!.exit(0);
    await expect(boot).rejects.toThrow("before booting");
    expect(exits).toEqual([]);
    // Nothing to stop: a second kill or stop is a no-op.
    host.kill("quit");
    await host.stop("quit");
    expect(children[0]!.kills()).toBe(1);
  });

  it("kills a server that doesn't boot within the boot timeout", async () => {
    const { host, children, live } = setup({ bootTimeoutMs: 30_000 });
    const boot = host.start();
    expect(live().map((timer) => timer.ms)).toEqual([30_000]);
    live()[0]!.callback();
    await expect(boot).rejects.toThrow("server didn't boot within 30s");
    expect(children[0]!.kills()).toBe(1);
    expect(host.state()).toBe("crashed");
    // A boot message from the timed-out child is too late to count.
    children[0]!.boot();
    expect(host.url()).toBe("");
  });

  it("restarts a server that exits after boot, and moves onto the new boot", async () => {
    const { host, children, exits, recovered, backoff, booted, live } = setup();
    await booted();
    children[0]!.exit(1);
    expect(exits).toEqual([{ code: 1, booted: true }]);
    expect(host.state()).toBe("recovering");
    expect(children).toHaveLength(1);
    expect(backoff()).toBe(1_000);
    expect(children).toHaveLength(2);
    expect(host.state()).toBe("recovering");
    children[1]!.boot(BOOT_2);
    await flush();
    expect(host.state()).toBe("running");
    expect(host.url()).toBe(BOOT_2);
    expect(recovered).toEqual([BOOT_2]);
    expect(live()).toEqual([]);
  });

  it("backs off, then gives up once the restarts are used up, and retries on request", async () => {
    const { host, children, backoff, booted, gaveUp, recovered, live, latest } = setup();
    await booted();
    latest().exit(1);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= DEFAULT_RECOVERY.attempts; attempt++) {
      delays.push(backoff());
      latest().exit(2);
      await flush();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(children).toHaveLength(1 + DEFAULT_RECOVERY.attempts);
    expect(host.state()).toBe("failed");
    expect(gaveUp).toEqual(["server exited with code 2"]);
    expect(live()).toEqual([]);

    host.retry();
    expect(children).toHaveLength(2 + DEFAULT_RECOVERY.attempts);
    latest().boot(BOOT_2);
    await flush();
    expect(host.state()).toBe("running");
    expect(recovered).toEqual([BOOT_2]);
    // The budget is whole again: the next crash waits the first delay.
    latest().exit(1);
    expect(backoff()).toBe(1_000);
  });

  it("caps the backoff", () => {
    expect(restartDelay(DEFAULT_RECOVERY, 1)).toBe(1_000);
    expect(restartDelay(DEFAULT_RECOVERY, 6)).toBe(30_000);
    expect(restartDelay(DEFAULT_RECOVERY, 40)).toBe(30_000);
  });

  it("counts afresh after a restarted server stayed up, but not after a short run", async () => {
    const { host, backoff, booted, clock, latest } = setup();
    await booted();
    latest().exit(1);
    expect(backoff()).toBe(1_000);
    latest().boot(BOOT_2);
    await flush();
    clock.now += 5_000;
    latest().exit(1);
    expect(backoff()).toBe(2_000);
    latest().boot(BOOT_2);
    await flush();
    clock.now += DEFAULT_RECOVERY.stableMs;
    latest().exit(1);
    expect(backoff()).toBe(1_000);
    expect(host.state()).toBe("recovering");
  });

  it("counts a restart that doesn't boot in time as failed, once it has exited", async () => {
    const { host, children, backoff, booted, live, latest, exits, fire } = setup({
      bootTimeoutMs: 30_000,
    });
    await booted();
    latest().exit(1);
    backoff();
    fire(30_000);
    await flush();
    expect(latest().kills()).toBe(1);
    expect(host.state()).toBe("recovering");
    // A boot from the timed-out child is too late to count.
    latest().boot(BOOT_2);
    expect(host.url()).toBe(BOOT);
    // Nothing is scheduled, let alone forked, until it has gone.
    expect(live().map((timer) => timer.ms)).toEqual([10_000]);
    await expect(host.start()).rejects.toThrow("didn't boot");
    expect(children).toHaveLength(2);
    latest().exit(143);
    expect(exits).toEqual([{ code: 1, booted: true }]);
    expect(backoff()).toBe(2_000);
    expect(children).toHaveLength(3);
  });

  it("kills a timed-out child outright when it ignores the kill, and only then restarts", async () => {
    const { host, children, backoff, booted, latest, forceKilled, lines, fire, gaveUp } = setup({
      bootTimeoutMs: 30_000,
    });
    await booted();
    latest().exit(1);
    backoff();
    const stuck = latest();
    fire(30_000);
    await flush();
    fire(10_000);
    expect(forceKilled).toEqual([stuck.child.pid]);
    expect(children).toHaveLength(2);
    stuck.exit(137);
    expect(host.state()).toBe("recovering");
    backoff();
    expect(children).toHaveLength(3);

    // One that outlives even that stays tracked: recovery is reported failed, and nothing forks
    // beside it, not even on a retry, until it has exited.
    const lingering = latest();
    fire(30_000);
    await flush();
    fire(10_000);
    fire(2_000);
    expect(lines.at(-1)).toMatchObject({ level: "error" });
    expect(host.state()).toBe("failed");
    expect(gaveUp).toEqual([
      "server didn't boot within 30s, and it is still running after being killed",
    ]);
    host.retry();
    expect(children).toHaveLength(3);
    lingering.exit(137);
    expect(children).toHaveLength(4);
    latest().boot(BOOT_2);
    await flush();
    expect(host.state()).toBe("running");
  });

  it("starts nothing beside a stopped server that outlived its kill", async () => {
    const { host, children, booted, fire, latest } = setup();
    await booted();
    const stop = host.stop("update");
    fire(10_000);
    await flush();
    fire(2_000);
    expect(await stop).toBe("lingering");
    // The update service's restart after a failed installer launch, then the dialog's Try Again.
    await expect(host.start()).rejects.toThrow("still running");
    host.retry();
    expect(children).toHaveLength(1);
    latest().exit(137);
    await flush();
    expect(children).toHaveLength(2);
  });

  it("holds a retry asked for while a timed-out start is exiting until it has", async () => {
    const { host, children, latest, fire, recovered } = setup({ bootTimeoutMs: 30_000 });
    // The update service's restart: an explicit start, not a recovery.
    const boot = host.start();
    fire(30_000);
    await expect(boot).rejects.toThrow("didn't boot");
    host.retry();
    expect(children).toHaveLength(1);
    latest().exit(143);
    expect(children).toHaveLength(2);
    latest().boot(BOOT_2);
    await flush();
    expect(recovered).toEqual([BOOT_2]);
  });

  it("still reaches a timed-out child that is being made to exit when the app quits", async () => {
    const { host, booted, live, latest, children, fire } = setup({ bootTimeoutMs: 30_000 });
    await booted();
    latest().exit(1);
    fire(1_000);
    fire(30_000);
    await flush();
    host.kill("quit");
    expect(latest().kills()).toBe(2);
    latest().exit(0);
    expect(host.state()).toBe("stopped");
    expect(live().filter((timer) => timer.ms !== 10_000)).toEqual([]);
    expect(children).toHaveLength(2);
  });

  it("tells boot listeners about every boot, restarts included", async () => {
    const { host, booted, backoff, latest } = setup();
    const boots: string[] = [];
    host.onBoot((url) => boots.push(url));
    await booted();
    latest().exit(1);
    backoff();
    latest().boot(BOOT_2);
    await flush();
    expect(boots).toEqual([BOOT, BOOT_2]);
  });

  it("never forks a second child while one restart is pending or booting", async () => {
    const { host, children, booted, live, latest } = setup();
    await booted();
    latest().exit(1);
    const pending = live().find((timer) => timer.ms === 1_000)!;
    // Started by hand before the backoff ran out: the backoff no longer forks.
    const boot = host.start();
    expect(children).toHaveLength(2);
    expect(pending.cleared).toBe(true);
    expect(host.start()).toBe(boot);
    pending.callback();
    expect(children).toHaveLength(2);
    host.retry();
    expect(children).toHaveLength(2);
  });

  it("restarts nothing once it quits during recovery, waiting or booting", async () => {
    const waiting = setup();
    await waiting.booted();
    waiting.latest().exit(1);
    const pending = waiting.live()[0]!;
    waiting.host.kill("quit");
    expect(waiting.host.state()).toBe("stopped");
    expect(pending.cleared).toBe(true);
    pending.callback();
    expect(waiting.children).toHaveLength(1);

    const booting = setup();
    await booting.booted();
    booting.latest().exit(1);
    booting.backoff();
    expect(booting.children).toHaveLength(2);
    booting.host.kill("quit");
    expect(booting.latest().kills()).toBe(1);
    booting.latest().exit(0);
    await flush();
    expect(booting.host.state()).toBe("stopped");
    expect(booting.live()).toEqual([]);
    expect(booting.children).toHaveLength(2);
    expect(booting.recovered).toEqual([]);
  });

  it("lets an exit listener that stops the host cancel the restart", async () => {
    const { host, booted, latest, live, children } = setup();
    host.onUnexpectedExit(() => host.kill("smoke"));
    await booted();
    latest().exit(1);
    expect(live()).toEqual([]);
    expect(host.state()).toBe("stopped");
    expect(children).toHaveLength(1);
  });

  it("leaves an update's stop alone, and doesn't restart after a failed restart for one", async () => {
    const { host, booted, latest, live, children, gaveUp } = setup();
    await booted();
    const stop = host.stop("update");
    latest().exit(0);
    await stop;
    expect(live()).toEqual([]);
    // The installer didn't launch, so the update service starts the server again; it fails.
    const again = host.start();
    latest().exit(1);
    await expect(again).rejects.toThrow("before booting");
    expect(host.state()).toBe("crashed");
    expect(live()).toEqual([]);
    expect(children).toHaveLength(2);
    expect(gaveUp).toEqual([]);
  });

  it("cancels a pending restart when an update stops the server mid-recovery", async () => {
    const { host, booted, latest, live, children } = setup();
    await booted();
    latest().exit(1);
    expect(await host.stop("update")).toBe("unconfirmed");
    expect(host.state()).toBe("stopped");
    expect(live()).toEqual([]);
    expect(children).toHaveLength(1);
  });

  describe("health check", () => {
    it("kills a server that stops answering and restarts it like a crash", async () => {
      const { pings, health } = pinging();
      const { booted, fire, clock, lines, forceKilled, latest, backoff, recovered, children } =
        setup({ health });
      await booted();
      fire(15_000);
      expect(pings[0]!.url).toBe(BOOT);
      pings[0]!.answer();
      await flush();
      for (let missed = 1; missed <= 3; missed += 1) {
        clock.now += 25_000;
        fire(15_000);
        pings[missed]!.miss();
        await flush();
      }
      expect(lines.filter((line) => line.message === "server isn't answering")).toHaveLength(1);
      expect(forceKilled).toEqual([]);
      clock.now += 25_000;
      fire(15_000);
      pings[4]!.miss();
      await flush();
      expect(forceKilled).toEqual([latest().child.pid]);
      expect(lines.at(-1)?.message).toBe("server stopped answering for 75s; killing it");
      latest().exit(137);
      expect(lines.at(-1)?.message).toBe("server stopped answering for 75s; restarting it");
      backoff();
      children[1]!.boot(BOOT_2);
      await flush();
      expect(recovered).toEqual([BOOT_2]);
    });

    it("logs how long it was down when it answers again, and starts over after a sleep", async () => {
      const { pings, health } = pinging();
      const { booted, fire, clock, lines, forceKilled } = setup({ health });
      await booted();
      fire(15_000);
      pings[0]!.miss();
      await flush();
      clock.now += 25_000;
      fire(15_000);
      pings[1]!.answer();
      await flush();
      expect(lines.at(-1)).toEqual({
        level: "info",
        fields: { source: "server", downMs: 25_000 },
        message: "server answering again",
      });
      fire(15_000);
      pings[2]!.miss();
      await flush();
      // Asleep for an hour: the first ping after waking doesn't count that hour as unanswered.
      clock.now += 3_600_000;
      fire(15_000);
      pings[3]!.miss();
      await flush();
      expect(forceKilled).toEqual([]);
    });

    it("counts a hung server's restarts against the budget, however long it was up", async () => {
      const { pings, health } = pinging();
      const { booted, fire, clock, lines, latest, backoff, children } = setup({ health });
      await booted();
      /** Leaves the latest child unanswered until it is killed, and returns its restart attempt. */
      const hangUntilKilled = async () => {
        while (!lines.at(-1)?.message.endsWith("; killing it")) {
          clock.now += 25_000;
          fire(15_000);
          pings.at(-1)!.miss();
          await flush();
        }
        latest().exit(137);
        return (lines.at(-1)!.fields as { attempt?: number }).attempt;
      };
      // Up for over `stableMs` each time, but never answering: no fresh budget.
      expect(await hangUntilKilled()).toBe(1);
      backoff();
      children[1]!.boot(BOOT_2);
      await flush();
      expect(await hangUntilKilled()).toBe(2);
    });

    it("doesn't count a ping the Mac slept through as unanswered", async () => {
      const { pings, health } = pinging();
      const { booted, fire, clock, forceKilled } = setup({ health });
      await booted();
      fire(15_000);
      pings[0]!.miss();
      await flush();
      clock.now += 25_000;
      fire(15_000);
      // The ping in flight when the lid closed fails on waking, an hour on.
      clock.now += 3_600_000;
      pings[1]!.miss();
      await flush();
      clock.now += 25_000;
      fire(15_000);
      pings[2]!.miss();
      await flush();
      expect(forceKilled).toEqual([]);
    });

    it("stops pinging a server that was stopped", async () => {
      const { pings, health } = pinging();
      const { host, booted, latest, live } = setup({ health });
      await booted();
      const stop = host.stop("update");
      latest().exit(0);
      await stop;
      expect(live().filter((timer) => timer.ms === 15_000)).toHaveLength(0);
      expect(pings).toHaveLength(0);
    });
  });
});
