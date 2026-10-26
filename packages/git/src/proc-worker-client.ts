// macOS exec authorization can hold even asynchronous spawn inside its synchronous native call.
// Keep commands on a persistent worker so the server can still answer sockets during that wait.

import { join } from "node:path";
import { Worker } from "node:worker_threads";
import * as Effect from "effect/Effect";
import { ProcSpawnError, ProcTimeout } from "./errors.ts";
import type { ProcOutput, RunOptions } from "./proc.ts";
import { TIER_MILLIS } from "./proc-bounds.ts";

/** Messages carry command data only in memory; output and arguments are never logged. */
export interface CommandRequest {
  readonly type: "run";
  readonly id: number;
  readonly exe: string;
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly options: Omit<RunOptions, "onOutput">;
  readonly env: Readonly<Record<string, string>>;
  readonly progress: boolean;
}

/** The worker's result, or an output chunk for progress reporting. */
export type CommandResponse =
  | { readonly type: "output"; readonly id: number; readonly text: string }
  | {
      readonly type: "done";
      readonly id: number;
      readonly result:
        | ProcOutput
        | { readonly error: "spawn" | "timeout"; readonly message: string };
    };

/** A scoped worker running the same bounded, capped and reaped commands as the direct platform. */
export const makeCommandWorker = (
  // Vitest defines __dirname even for TypeScript source. Select source before the CJS bundle path.
  file: string | URL = import.meta.url.endsWith(".ts")
    ? new URL("./proc-worker.ts", import.meta.url)
    : typeof __dirname === "string"
      ? join(__dirname, "proc-worker.js")
      : new URL("./proc-worker.js", import.meta.url),
) =>
  Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => new Worker(file)),
      (child) =>
        Effect.promise(async () => {
          if (stopped) return;
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
          child.postMessage({ type: "shutdown" });
          await exited;
        }),
    );
    let stopped = false;
    let failed: string | undefined;
    let sequence = 0;
    const pending = new Map<
      number,
      {
        readonly complete: (result: CommandResponse & { readonly type: "done" }) => void;
        readonly output: ((text: string) => void) | undefined;
      }
    >();
    let resolveExit: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const fail = (message: string) => {
      failed = message;
      for (const [id, request] of pending) {
        request.complete({ type: "done", id, result: { error: "spawn", message } });
      }
      pending.clear();
    };
    worker.on("error", (error) => fail(error instanceof Error ? error.message : String(error)));
    worker.on("exit", () => {
      stopped = true;
      fail("command worker exited");
      resolveExit!();
    });
    worker.on("message", (message: CommandResponse) => {
      const request = pending.get(message.id);
      if (message.type === "output") request?.output?.(message.text);
      else {
        pending.delete(message.id);
        request?.complete(message);
      }
    });
    return (
      exe: string,
      bin: string,
      args: ReadonlyArray<string>,
      options: RunOptions,
      env: Readonly<Record<string, string>>,
    ) =>
      Effect.callback<ProcOutput, ProcSpawnError | ProcTimeout>((resume) => {
        if (failed !== undefined) {
          resume(Effect.fail(new ProcSpawnError({ bin, message: failed })));
          return;
        }
        const id = sequence++;
        let resolveDone: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        pending.set(id, {
          output: options.onOutput,
          complete: ({ result }) => {
            resolveDone!();
            resume(
              "error" in result
                ? Effect.fail(
                    result.error === "timeout"
                      ? new ProcTimeout({ bin, message: result.message })
                      : new ProcSpawnError({ bin, message: result.message }),
                  )
                : Effect.succeed(result),
            );
          },
        });
        // Functions don't cross to the worker: output comes back as messages, and the omitted env is
        // applied here, leaving the worker plain data.
        const { onOutput: _onOutput, omitEnv, ...serializable } = options;
        const request = {
          type: "run",
          id,
          exe,
          bin,
          args,
          options: serializable,
          env:
            omitEnv === undefined
              ? env
              : Object.fromEntries(Object.entries(env).filter(([name]) => !omitEnv(name))),
          progress: options.onOutput !== undefined,
        } satisfies CommandRequest;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
        worker.postMessage(request);
        // Interruption must wait for runCommand's scope to kill and reap the child. A worker held in
        // native spawn processes this cancellation as soon as exec authorization returns.
        return Effect.promise(async () => {
          if (!pending.has(id)) return;
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
          worker.postMessage({ type: "cancel", id });
          await done;
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.timeoutMs ?? TIER_MILLIS[options.tier ?? "local"],
          orElse: () => Effect.fail(new ProcTimeout({ bin, message: `${bin} timed out` })),
        }),
      );
  });
