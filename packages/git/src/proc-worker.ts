// Worker entry point only. All subprocesses still go through runCommand and its scope finalizers.

import { parentPort } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { runCommandWithPlatform } from "./proc.ts";
import type { CommandRequest, CommandResponse } from "./proc-worker-client.ts";

const port = parentPort;
if (port === null) throw new Error("command worker needs a parent port");
const runs = new Map<number, { cancel: (() => void) | undefined; cancelled: boolean }>();
let closing = false;
const finishShutdown = () => {
  if (closing && runs.size === 0) port.close();
};

port.on(
  "message",
  (message: CommandRequest | { type: "cancel"; id: number } | { type: "shutdown" }) => {
    if (message.type === "shutdown") {
      closing = true;
      for (const run of runs.values()) {
        run.cancelled = true;
        run.cancel?.();
      }
      finishShutdown();
      return;
    }
    if (message.type === "cancel") {
      const run = runs.get(message.id);
      if (run !== undefined) {
        run.cancelled = true;
        run.cancel?.();
      }
      return;
    }
    const request = message;
    const run = { cancel: undefined as (() => void) | undefined, cancelled: closing };
    runs.set(request.id, run);
    // Drain cancellations before starting another native spawn after a previous one was held up.
    setImmediate(() => {
      const command = run.cancelled
        ? Effect.interrupt
        : runCommandWithPlatform(
            request.exe,
            request.bin,
            request.args,
            {
              ...request.options,
              onOutput: request.progress
                ? (text) =>
                    port.postMessage({
                      type: "output",
                      id: request.id,
                      text,
                    } satisfies CommandResponse)
                : undefined,
            },
            request.env,
          );
      run.cancel = Effect.runCallback(command, {
        onExit: (exit) => {
          runs.delete(request.id);
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          port.postMessage({
            type: "done",
            id: request.id,
            result: Exit.isSuccess(exit)
              ? exit.value
              : {
                  error:
                    error !== undefined &&
                    typeof error === "object" &&
                    error !== null &&
                    "_tag" in error &&
                    error._tag === "ProcTimeout"
                      ? "timeout"
                      : "spawn",
                  message: error instanceof Error ? error.message : "command interrupted",
                },
          } satisfies CommandResponse);
          finishShutdown();
        },
      });
    });
  },
);
