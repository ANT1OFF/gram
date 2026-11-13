import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { carriers, psCarriers, RUN_TOKEN_ENV, sweepRun } from "./run-sweep.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the sweep of a kept-running host's processes", () => {
  it("reads which processes carry the token from `ps -E` (macOS)", () => {
    const token = "a".repeat(32);
    const listing = [
      `  101 /bin/zsh -l HOME=/Users/x ${RUN_TOKEN_ENV}=${token} TERM=xterm`,
      `  102 sleep 999 ${RUN_TOKEN_ENV}=${token}`,
      `  103 sleep 999 ${RUN_TOKEN_ENV}=${token}b`,
      `  104 grep ${RUN_TOKEN_ENV}`,
      "  105 /usr/bin/other",
    ].join("\n");
    expect(psCarriers(token, listing)).toEqual([101, 102]);
  });

  it.live.skipIf(process.platform !== "linux")(
    "ends a detached descendant that left its terminal's session, as the review reproduced",
    () =>
      Effect.gen(function* () {
        const token = randomBytes(16).toString("hex");
        // A shell's background job that left its session and its parent: `setsid` and detached,
        // as a pseudo-terminal's shell's `nohup … &` is once the shell ends.
        const child = spawn("setsid", ["sh", "-c", "sleep 120"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, [RUN_TOKEN_ENV]: token },
        });
        child.unref();
        yield* Effect.sleep("300 millis");
        const found = yield* carriers(token);
        expect(found.length).toBeGreaterThan(0);
        const swept = yield* sweepRun(token, "linux", 1_000);
        expect(swept.left).toEqual([]);
        for (const pid of found) expect(alive(pid)).toBe(false);
        // Another run's token, or none, ends nothing.
        expect((yield* sweepRun("b".repeat(32), "linux")).found).toBe(0);
        expect((yield* sweepRun("not a token", "linux")).found).toBe(0);
      }),
    20_000,
  );
});
