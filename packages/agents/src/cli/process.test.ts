import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { runCommand } from "./process.ts";

// BSD ps (macOS) has no `sid` keyword and reports `sess` as 0, so a session id is only readable on
// Linux. The process group is readable on both, and setsid() makes the probe its own group leader.
// Linux keeps the session check as well.
const psFields = process.platform === "linux" ? "pgid=,sid=" : "pgid=";

it.skipIf(process.platform === "win32")(
  "isolates login probes from the desktop terminal session",
  async () => {
    const [parentGroup, parentSession] = execFileSync(
      "ps",
      ["-o", psFields, "-p", String(process.pid)],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    const output = await Effect.runPromise(
      runCommand("/bin/sh", ["-c", `echo $$; ps -o ${psFields} -p $$`], {
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 3000,
        isolateSession: true,
      }),
    );
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toMatch(/^\d+(\s+\d+)+$/);
    const [pid, probeGroup, probeSession] = output.stdout.trim().split(/\s+/).map(Number);
    expect(probeGroup).toBe(pid);
    expect(probeGroup).not.toBe(parentGroup);
    if (process.platform === "linux") {
      expect(probeSession).toBe(pid);
      expect(probeSession).not.toBe(parentSession);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "kills a detached probe's background child when the probe times out",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-probe-"));
    const pidFile = join(dir, "child");
    const script = `sleep 30 & echo $! > '${pidFile}'; echo READY`;
    const started = Date.now();
    try {
      // The background child holds stdout open, so the probe ends only by its timeout.
      const error = await Effect.runPromise(
        Effect.flip(
          runCommand("/bin/bash", ["-c", script], {
            env: { PATH: "/usr/bin:/bin" },
            timeoutMs: 1_000,
            isolateSession: true,
          }),
        ),
      );
      expect(error.message).toMatch(/timed out/);
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(pid)).toBe(true);
      // Gone, or a zombie a container's init hasn't reaped yet: either way no longer running.
      const running = () => {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        if (process.platform !== "linux") return true;
        try {
          return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2_000;
      while (running() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(running()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
