import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_OUTPUT_EVENT_MAX, DEVICE_OUTPUT_MAX_BYTES } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "./environment.ts";
import { type CommandRequest, OUTPUT_PIECES_MOST, runCommand, shellEnvironment } from "./runner.ts";

let cwd: string;
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const quick = { killAfterMs: 300, drainAfterExitMs: 200 };

beforeEach(async () => {
  cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-run-")));
});
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

const run = (command: string, more: Partial<CommandRequest> = {}) =>
  runCommand(
    {
      command,
      cwd,
      env,
      secrets: [],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      ...more,
    },
    quick,
  );

const text = (
  result: { output: ReadonlyArray<{ stream: string; text: string }> },
  stream: string,
) =>
  result.output
    .filter((piece) => piece.stream === stream)
    .map((piece) => piece.text)
    .join("");

/** Whether a process is still running; one that was killed and not yet collected is not. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)])
      .toString()
      .trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("runCommand", () => {
  it("runs in the folder it was given and says how it ended", async () => {
    const result = await run("pwd; echo oops >&2; exit 3");
    expect(text(result, "stdout")).toBe(`${cwd}\n`);
    expect(text(result, "stderr")).toBe("oops\n");
    expect(result).toMatchObject({ code: 3, truncated: false, timedOut: false, stopped: false });
  });

  it("gets exactly the environment it was given, and nothing of the app's own", async () => {
    process.env.GRAM_TEST_LEAK = "leaked";
    try {
      const result = await run('echo "[$GRAM_TEST_LEAK][$ONLY]"', {
        env: { ...env, ONLY: "this" },
      });
      expect(text(result, "stdout")).toBe("[][this]\n");
    } finally {
      delete process.env.GRAM_TEST_LEAK;
    }
  });

  it("reads no start-up file, has no stdin and no terminal", async () => {
    await fs.writeFile(join(cwd, "rc"), "echo FROM-RC\n");
    const result = await run("cat; test -t 0 || echo no-tty; test -t 1 || echo no-tty-out", {
      env: { ...env, ENV: join(cwd, "rc"), BASH_ENV: join(cwd, "rc") },
    });
    expect(text(result, "stdout")).toBe("no-tty\nno-tty-out\n");
    expect(result.code).toBe(0);
  });

  it("redacts removed values from both streams, however the output is cut", async () => {
    const secret = "hunter2-hunter2-hunter2";
    const result = await run(
      "printf 'a hunter2-hun'; sleep 0.2; printf 'ter2-hunter2 b\\n'; echo hunter2-hunter2-hunter2 >&2",
      { secrets: [secret] },
    );
    expect(text(result, "stdout")).toBe(`a ${REDACTED} b\n`);
    expect(text(result, "stderr")).toBe(`${REDACTED}\n`);
  });

  it("keeps a character whole when it arrives in two reads", async () => {
    const result = await run("printf '\\342\\202'; sleep 0.2; printf '\\254\\n'");
    expect(text(result, "stdout")).toBe("€\n");
  });

  it("keeps the end of output over the limit, in pieces small enough to send", async () => {
    const result = await run(
      `head -c ${DEVICE_OUTPUT_MAX_BYTES + 50_000} /dev/zero | tr '\\0' 'x'; echo; echo THE-END`,
    );
    expect(result.truncated).toBe(true);
    const out = text(result, "stdout");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(DEVICE_OUTPUT_MAX_BYTES);
    expect(Buffer.byteLength(out)).toBeGreaterThan(DEVICE_OUTPUT_MAX_BYTES - 8);
    expect(out.endsWith("\nTHE-END\n")).toBe(true);
    for (const piece of result.output)
      expect(piece.text.length).toBeLessThanOrEqual(DEVICE_OUTPUT_EVENT_MAX);
  });

  it("stops a command at its timeout, with everything it started", async () => {
    const started = Date.now();
    const result = await run("sleep 30 & echo $!; wait", { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ timedOut: true, stopped: false });
    const pid = Number(text(result, "stdout").trim());
    expect(pid).toBeGreaterThan(1);
    await new Promise((later) => setTimeout(later, 100));
    expect(alive(pid)).toBe(false);
  });

  it("kills a command that ignores being asked to stop", async () => {
    const started = Date.now();
    const result = await run("trap '' TERM; echo ready; sleep 30", { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("stops when told to, and doesn't start once told", async () => {
    const controller = new AbortController();
    const running = run("echo ready; sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await running).toMatchObject({ stopped: true, timedOut: false });
    const marker = join(cwd, "ran");
    const never = await run(`touch ${marker}`, { signal: controller.signal });
    expect(never).toEqual({ output: [], truncated: false, timedOut: false, stopped: true });
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("doesn't wait for, or leave behind, what a command put in the background", async () => {
    const started = Date.now();
    const result = await run("sleep 30 & echo $!");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.code).toBe(0);
    const pid = Number(text(result, "stdout").trim());
    await new Promise((later) => setTimeout(later, 100));
    expect(alive(pid)).toBe(false);
  });

  it("keeps output a command writes a byte at a time in few pieces", async () => {
    const result = await run(
      "i=0; while [ $i -lt 400 ]; do printf a; printf b >&2; i=$((i+1)); done",
    );
    expect(result.output.length).toBeLessThanOrEqual(OUTPUT_PIECES_MOST);
    expect(text(result, "stdout").length + text(result, "stderr").length).toBe(800);
    const single = await run("i=0; while [ $i -lt 400 ]; do printf a; i=$((i+1)); done");
    expect(single.output).toEqual([{ stream: "stdout", text: "a".repeat(400) }]);
  });

  it("drops what would change the meaning of a command under bash", async () => {
    expect(
      shellEnvironment({
        PATH: "/bin",
        "BASH_FUNC_ls%%": "() { echo hijacked; }",
        SHELLOPTS: "xtrace",
        BASHOPTS: "x",
        ENV: "/x",
        BASH_ENV: "/x",
        PS4: "x",
        CDPATH: "/",
        IFS: "x",
        LANG: "C",
      }),
    ).toEqual({ PATH: "/bin", LANG: "C" });
    const bash = await fs.stat("/bin/bash").then(
      () => true,
      () => false,
    );
    if (!bash) return;
    const result = await run("/bin/bash -c 'ls / >/dev/null && echo plain'", {
      env: { ...env, "BASH_FUNC_ls%%": "() { echo hijacked; }" },
    });
    expect(text(result, "stdout")).toBe("plain\n");
  });

  it("says the folder is gone rather than that the shell is missing", async () => {
    await expect(run("echo hi", { cwd: join(cwd, "nope") })).rejects.toThrow(/folder is gone/);
  });

  it("never signals the command's group once its shell has been collected", async () => {
    const signals: Array<number> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) signals.push(pid);
      return true;
    });
    let exitedAt = 0;
    try {
      // Holds the pipes after the shell ends, so the end waits out the drain time.
      const result = await run(
        "setsid sh -c 'sleep 2' >/dev/null 2>&1 </dev/null & sleep 2 & echo started",
        { timeoutMs: 10_000 },
      );
      exitedAt = signals.length;
      expect(result.code).toBe(0);
    } finally {
      kill.mockRestore();
    }
    // Exactly one: the SIGKILL sent as the shell was collected, none after.
    expect(exitedAt).toBe(1);
  });

  it("doesn't call a command stopped or timed out once its shell has ended by itself", async () => {
    const controller = new AbortController();
    const signals: Array<number> = [];
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation((pid) => {
      if (pid < 0) signals.push(pid);
      return true;
    });
    try {
      // The shell ends at once; a process it left holds the output for the drain time.
      const running = run(
        "setsid sh -c 'sleep 2' >/dev/null 2>&1 </dev/null & sleep 2 & echo started",
        {
          signal: controller.signal,
          timeoutMs: 50,
        },
      );
      await new Promise((later) => setTimeout(later, 120));
      controller.abort();
      const result = await running;
      expect(result).toMatchObject({ code: 0, stopped: false, timedOut: false });
    } finally {
      kill.mockRestore();
    }
    // Only the kill as the shell was collected: neither the timeout nor the abort signalled.
    expect(signals).toHaveLength(1);
  });

  it("says output was lost when something it left behind still held it open", async () => {
    // Out of its group, so the kill as the shell ends doesn't reach it, and it holds the output.
    const result = await run("setsid sh -c 'sleep 0.5; echo late' & sleep 0.1; echo now");
    expect(text(result, "stdout")).toBe("now\n");
    expect(result.truncated).toBe(true);
    const plain = await run("echo now");
    expect(plain.truncated).toBe(false);
  });

  it("never lets the kill that follows a stop reach a group whose shell has gone", async () => {
    const signals: Array<string> = [];
    const real = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementation((pid, signal) => {
      if (pid < 0) signals.push(String(signal));
      return real(pid, signal);
    });
    try {
      // Stopped at its timeout, the shell dies at once while a sleep out of its group holds the
      // output; the kill five seconds (here a tenth) later comes after the shell was collected.
      await runCommand(
        {
          command: "setsid sleep 1 & sleep 5",
          cwd,
          env,
          secrets: [],
          timeoutMs: 150,
          signal: new AbortController().signal,
        },
        { killAfterMs: 100, drainAfterExitMs: 500 },
      );
    } finally {
      kill.mockRestore();
    }
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
