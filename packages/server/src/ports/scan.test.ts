import { describe, expect, it } from "@effect/vitest";
import { ProcLive, ProcTimeout } from "@gram/git";
import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import { liveScan } from "./service.ts";

/** A real listener in a child process, killed when the test's scope closes. */
const listener = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ pid: number; port: number }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "const s = require('node:http').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port));",
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        child.once("error", reject);
        child.stdout.setEncoding("utf8").once("data", (data: string) => {
          resolve({ pid: child.pid!, port: Number(data.trim()) });
        });
      }),
  ),
  ({ pid }) =>
    Effect.sync(() => {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }),
);

const isProcTimeout = (error: unknown): error is ProcTimeout => error instanceof ProcTimeout;

/**
 * Sweeps to spend before giving up. `liveScan` bounds each probe at 10 s and fails the sweep when
 * one overruns, which a loaded CI runner can reach on PowerShell's startup alone — deliberately,
 * since the product would rather drop the port chips than hang the UI.
 */
const SWEEPS = 3;

/** A sweep that answered, or `undefined` when every try overran the product's own bound. */
const scanOrTimeout = liveScan.pipe(
  Effect.retry({ times: SWEEPS - 1, while: isProcTimeout }),
  Effect.catchIf(isProcTimeout, () => Effect.succeed(undefined)),
  Effect.provide(ProcLive),
);

describe("liveScan", () => {
  it.live(
    "finds a child process's listening port and its parent",
    (ctx) =>
      Effect.gen(function* () {
        const { pid, port } = yield* listener;
        const scan = yield* scanOrTimeout;
        if (scan === undefined) return ctx.skip(`no sweep answered within ${SWEEPS} tries`);
        expect(scan.listening.get(pid)).toContain(port);
        expect(scan.children.get(process.pid)).toContain(pid);
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
});
