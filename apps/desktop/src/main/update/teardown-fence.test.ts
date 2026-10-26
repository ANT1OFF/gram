// The update stop's fence over real processes: a forked stand-in for the server, with a stand-in
// terminal and the process that terminal started under it, stopped by the real host, killed by the
// real `killTree` and checked by the real numeric tree check. The stand-in plays the server's side
// of the protocol only (`packages/server/src/main.ts`); no app, agent, provider CLI, account or
// network is used, and its environment is set here rather than inherited.

import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateTeardown } from "@gram/contracts";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { killTree, type RunSync } from "../process-tree.ts";
import { createServerHost, NO_RECOVERY, type ServerChild } from "../server-host.ts";
import { stopForUpdate } from "./shutdown.ts";
import { watchTree, type TreeCheckDeps } from "./tree-check.ts";

const BOOT = "http://127.0.0.1:51041/?boot=c4b154241fdbc8678cdca7eeaa9f1c5e";

/** Keep orphaning, but attest only after four parents have exited and their children are adopted. */
const ORPHANING = String.raw`
const orphaning = (ready) => {
  let adopted = 0;
  setInterval(() => {
    const parent = spawn(process.execPath, [process.env.FENCE_ORPHAN], { stdio: "ignore" });
    parent.once("exit", (code) => {
      if (code === 0 && ++adopted === 4) ready();
    });
  }, 20);
};
`;

/**
 * `FENCE_MODE`: `fast` ends its tree and attests a complete teardown at once; `hang` has a
 * non-essential finalizer that never ends and, asked for an update, seals its essentials;
 * `essential` reports the database essential failed and hangs. `orphans` also, once asked to stop,
 * keeps starting processes whose parent exits at once, so launchd adopts them before any read sees
 * them under the server; `terminal-orphans` has its terminal do that, the terminal leading its own
 * process group as a pty's shell does. Each adopted process's pid goes to `FENCE_ORPHANS`.
 * Both attest essentials only after four orphan-creating parents have exited; elapsed time says
 * nothing about how many Node children have started on a loaded runner.
 */
const STAND_IN = String.raw`
const { spawn } = require("node:child_process");
const mode = process.env.FENCE_MODE;
${ORPHANING}
// A terminal and the process it runs, both under the server.
const terminal = spawn(process.execPath, [process.env.FENCE_TERMINAL], {
  stdio: ["ignore", "pipe", "ignore", "ipc"],
  detached: mode === "terminal-orphans",
});
terminal.stdout.once("data", (data) => {
  const nested = Number(String(data).trim());
  process.send({ type: "fixture", pids: [terminal.pid, nested] });
  process.send({ type: "boot", url: ${JSON.stringify(BOOT)} });
  process.on("message", (message) => {
    if (message?.type !== "shutdown") return;
    if (mode === "fast") {
      process.kill(nested, "SIGTERM");
      terminal.once("exit", () => {
        process.send({ type: "shutdownComplete", success: true }, () => process.exit(0));
      });
      terminal.kill("SIGTERM");
      return;
    }
    // Only an update's server seals its essentials; an older one never did.
    if (message.reason !== "update") return;
    const attest = () => {
      process.send(
        mode === "essential"
          ? { type: "shutdownEssentials", success: false, failed: "database" }
          : { type: "shutdownEssentials", success: true, waitingOn: { TCPSocketWrap: 1, Timeout: 2 } },
      );
    };
    if (mode === "orphans") {
      orphaning(attest);
    } else if (mode === "terminal-orphans") {
      terminal.once("message", (message) => {
        if (message?.type === "orphansReady") attest();
      });
      terminal.kill("SIGUSR2");
    } else {
      setTimeout(attest, 100);
    }
  });
});
`;

/** The stand-in terminal: runs one process, and on SIGUSR2 starts orphaning as the server does. */
const TERMINAL = String.raw`
const { spawn } = require("node:child_process");
const runs = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
${ORPHANING}
process.on("SIGUSR2", () => orphaning(() => process.send({ type: "orphansReady" })));
setInterval(() => {}, 1e6);
// Reporting the nested pid is also readiness: the orphaning signal handler is installed now.
console.log(runs.pid);
`;

/** Starts an idle process, records its pid and exits at once, leaving it to launchd. */
const ORPHAN = String.raw`
const adopted = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
require("node:fs").appendFileSync(process.env.FENCE_ORPHANS, adopted.pid + "\n");
process.exit(0);
`;

const dir = mkdtempSync(join(tmpdir(), "gram-teardown-fence-"));
const script = join(dir, "server.cjs");
writeFileSync(script, STAND_IN);
writeFileSync(join(dir, "terminal.cjs"), TERMINAL);
writeFileSync(join(dir, "orphan.cjs"), ORPHAN);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runSync: RunSync = (file, args, timeoutMs) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs });
  return result.error === undefined ? result : undefined;
};
const deps: TreeCheckDeps = {
  platform: process.platform,
  run: runSync,
  signal: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Whether `pid` still runs. On Linux an ended process stays listed as a zombie until its parent
 * reaps it, and one adopted by a PID 1 that never reaps (a container's) stays so for good: it has
 * ended, so it counts as gone.
 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    // The state follows the command name, which is in parentheses and may hold spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
};

/** Which of `pids` still run after up to 2 s: a killed orphan waits for launchd to reap it. */
const reaped = async (pids: ReadonlyArray<number>) => {
  for (let tries = 0; tries < 40; tries++) {
    if (!pids.some(alive)) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids.filter(alive);
};

const started: number[] = [];
afterEach(() => {
  // Include recorded orphans even when an assertion fails before the test can collect them.
  for (const pid of new Set([...started.splice(0), ...orphans()])) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
});

/**
 * The host over the stand-in in `mode`; `killRootOnly` loses everything under the root, as a kill
 * whose process table read failed does.
 */
const orphansFile = join(dir, "orphans.txt");
const orphans = () => {
  try {
    return readFileSync(orphansFile, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

const start = async (
  mode: "fast" | "hang" | "essential" | "orphans" | "terminal-orphans",
  killRootOnly = false,
) => {
  const pids: number[] = [];
  const lines: string[] = [];
  let child: ChildProcess | undefined;
  const host = createServerHost({
    fork: () => {
      // An explicit environment: nothing of the host's provider, auth or CLI state.
      // Its own process group, as a stand-in, so no other test's processes share it.
      child = fork(script, [], {
        env: {
          PATH: "/usr/bin:/bin",
          FENCE_MODE: mode,
          FENCE_ORPHANS: orphansFile,
          FENCE_ORPHAN: join(dir, "orphan.cjs"),
          FENCE_TERMINAL: join(dir, "terminal.cjs"),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
      started.push(child.pid!);
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        on: ((event: "message" | "exit", listener: (value: unknown) => void) =>
          event === "exit"
            ? child!.on("exit", (code, signal) => listener(code ?? (signal ? 137 : 0)))
            : child!.on("message", listener)) as ServerChild["on"],
        postMessage: (message) => child!.send(message as never),
        kill: () => child!.kill(),
      };
    },
    bootFromStdout: false,
    onMessage: (message) => {
      const { type, pids: reported } = message as { type?: string; pids?: number[] };
      if (type === "fixture" && reported) pids.push(...reported);
    },
    forceKill: (pid) => {
      if (killRootOnly) {
        process.kill(pid, "SIGKILL");
        return { under: 0, names: [] };
      }
      return killTree(pid, {
        platform: process.platform,
        run: runSync,
        kill: (target, signal) => process.kill(target, signal),
      });
    },
    treeCheck: { watch: (root) => watchTree(root, deps, new Map()) },
    log: {
      info: (_fields, message) => lines.push(message),
      warn: (_fields, message) => lines.push(message),
      error: (_fields, message) => lines.push(message),
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
    now: () => Date.now(),
    recovery: NO_RECOVERY,
  });
  await host.start();
  started.push(...pids);
  expect(pids).toHaveLength(2);
  expect(pids.every(alive)).toBe(true);
  return { host, pids, lines, root: () => child!.pid! };
};

describe.skipIf(process.platform === "win32")("update teardown fence", () => {
  it("keeps the clean path for a fast, complete teardown", async () => {
    const { host, pids } = await start("fast");
    const stopped: UpdateTeardown[] = [];
    await stopForUpdate(host, (teardown) => stopped.push(teardown));
    expect(stopped).toEqual([{ path: "clean" }]);
    expect(pids.some(alive)).toBe(false);
  });

  it("proceeds past a hanging non-essential finalizer once the essentials are attested", async () => {
    const { host, pids, root } = await start("hang");
    const stopped: UpdateTeardown[] = [];
    await stopForUpdate(host, (teardown) => stopped.push(teardown));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({
      path: "forced",
      killed: 2,
      waitingOn: { TCPSocketWrap: 1, Timeout: 2 },
    });
    // Names only: the executable, never a folder or an argument.
    const forced = stopped[0] as Extract<UpdateTeardown, { path: "forced" }>;
    expect(forced.names).toHaveLength(2);
    for (const name of forced.names) expect(name).not.toMatch(/[/\\]|setInterval/);
    // Nothing of the old tree is left: the server, its terminal or what that ran.
    expect([root(), ...pids].some(alive)).toBe(false);
  }, 30_000);

  it("refuses when an essential is reported failed, naming it", async () => {
    const { host } = await start("essential");
    await expect(stopForUpdate(host)).rejects.toThrow(
      /Update cancelled before app replacement\. The database could not be closed or sealed.*Gram remains on the running version/,
    );
  }, 30_000);

  it("refuses when a process of the old tree survives the kill", async () => {
    const { host, pids } = await start("hang", true);
    await expect(stopForUpdate(host)).rejects.toThrow(
      /Update cancelled before app replacement\. A process of the old server survived its kill\..*Gram remains on the running version/,
    );
    // Refused, the tree is still released: what survived the root's kill is killed after it.
    expect(await reaped(pids)).toEqual([]);
  }, 30_000);

  it.each(["orphans", "terminal-orphans"] as const)(
    "refuses, and leaves nothing alive, when processes orphaned during the stop escape the kill (%s)",
    async (mode) => {
      rmSync(orphansFile, { force: true });
      const { host, pids, root } = await start(mode);
      await expect(stopForUpdate(host)).rejects.toThrow(
        /Update cancelled before app replacement\. A process of the old server survived its kill\./,
      );
      const adopted = orphans();
      started.push(...adopted);
      // Several were adopted by launchd before the kill; none is left running after it.
      expect(adopted.length).toBeGreaterThan(3);
      expect(await reaped([root(), ...pids, ...adopted])).toEqual([]);
    },
    30_000,
  );
});
