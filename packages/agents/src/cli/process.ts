import { execFile, spawn } from "node:child_process";
import { batchFileInvocation, isWindowsBatchFile } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export interface CommandOutput {
  readonly stdout: string;
  /** `null` when the process was killed by a signal. */
  readonly exitCode: number | null;
}

/**
 * Runs a command without a shell, except a Windows batch file (npm's `claude.cmd`), which Node only
 * runs through `cmd.exe`, with its arguments escaped. A non-zero exit is an output, not a failure;
 * spawn errors and the timeout are failures. Interruption (including the timeout) kills the child.
 */
export const runCommand = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: Record<string, string>;
    readonly timeoutMs: number;
    /** Interactive login-shell probes must not take the desktop's controlling terminal. */
    readonly isolateSession?: boolean;
  },
): Effect.Effect<CommandOutput, CommandError> => {
  const command = [file, ...args].join(" ");
  const batch = process.platform === "win32" && isWindowsBatchFile(file);
  const invocation = batch ? batchFileInvocation(file, args) : { file, args };
  return Effect.callback<CommandOutput, CommandError>((resume, signal) => {
    // execFile drops `detached` before calling spawn; use spawn for a POSIX session boundary.
    // A login shell can background a profile job that inherits stdout. Abort must kill that
    // process group and drop the pipe, or `close` never runs and the child outlives the probe.
    if (options.isolateSession && process.platform !== "win32") {
      const child = spawn(invocation.file, [...invocation.args], {
        ...(options.env === undefined ? {} : { env: options.env }),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const stdout = child.stdout;
      if (stdout === null) {
        child.kill("SIGKILL");
        resume(Effect.fail(new CommandError({ command, message: "probe stdout was not piped" })));
        return Effect.void;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const killGroup = () => {
        stdout.destroy();
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // The probe already exited.
          }
        }
      };
      stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          killGroup();
          resume(Effect.fail(new CommandError({ command, message: "stdout exceeded 16 MiB" })));
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", (error) =>
        resume(Effect.fail(new CommandError({ command, message: error.message }))),
      );
      child.on("close", (exitCode) =>
        resume(Effect.succeed({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode })),
      );
      signal.addEventListener("abort", killGroup, { once: true });
      return Effect.sync(killGroup);
    }
    execFile(
      invocation.file,
      [...invocation.args],
      {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(batch ? { shell: true } : {}),
        signal,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error === null) return resume(Effect.succeed({ stdout, exitCode: 0 }));
        if (typeof error.code === "number") {
          return resume(Effect.succeed({ stdout, exitCode: error.code }));
        }
        if (error.signal) return resume(Effect.succeed({ stdout, exitCode: null }));
        resume(Effect.fail(new CommandError({ command, message: error.message })));
      },
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new CommandError({ command, message: `timed out after ${options.timeoutMs} ms` }),
        ),
    }),
  );
};
