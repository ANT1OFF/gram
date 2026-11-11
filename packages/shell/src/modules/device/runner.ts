import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { DEVICE_OUTPUT_EVENT_MAX, DEVICE_OUTPUT_MAX_BYTES, deviceTimeout } from "@gram/contracts";
import { makeRedactor } from "./environment.ts";

/**
 * Runs one allowed command on a lent machine. `/bin/sh -c` with no start-up files, no stdin and
 * no terminal, in a process group of its own so the group can be stopped. The output is
 * redacted as it arrives, kept to its last `DEVICE_OUTPUT_MAX_BYTES` and handed over when the
 * command has ended: keeping the end means nothing can be sent before the end is known.
 *
 * A process group bounds what a command starts only while it stays in the group. A command that
 * leaves it (`setsid`, a daemon) outlives the ask; confinement by the operating system is the
 * later step that closes this. The group is signalled last as the shell is collected, never
 * after, since its number may then be given to another process.
 */

export interface CommandRequest {
  readonly command: string;
  /** The real working folder, already checked. */
  readonly cwd: string;
  /** The environment to run with, already filtered. */
  readonly env: Readonly<Record<string, string>>;
  /** Values to redact from the output. */
  readonly secrets: ReadonlyArray<string>;
  readonly timeoutMs: number | undefined;
  /** Stops the command: a cancel, a closed connection, a lock or a quit. */
  readonly signal: AbortSignal;
}

export interface CommandOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface CommandResult {
  /** In the order it arrived, each piece small enough for one event. */
  readonly output: ReadonlyArray<CommandOutput>;
  readonly code?: number;
  readonly signal?: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** It was stopped through `signal` before it ended by itself. */
  readonly stopped: boolean;
}

/** How long a command has after `SIGTERM` before its tree is killed. */
export const KILL_AFTER_MS = 5000;
/** How long output may keep coming after the shell itself has ended. */
export const DRAIN_AFTER_EXIT_MS = 1000;

interface Timing {
  readonly killAfterMs: number;
  readonly drainAfterExitMs: number;
}

/**
 * Variables that change what a shell command means when `/bin/sh` is bash: exported functions,
 * options, start-up files, the prompt it traces with, where `cd` looks and how words split. They
 * come from the person's own login environment, and are dropped whatever the caller passes.
 */
const SHELL_MEANING = new Set(["SHELLOPTS", "BASHOPTS", "ENV", "BASH_ENV", "PS4", "CDPATH", "IFS"]);

export const shellEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !SHELL_MEANING.has(name) && !name.startsWith("BASH_FUNC_"),
    ),
  );

/** Pieces kept before the oldest are joined: a command writing a byte at a time stays small. */
export const OUTPUT_PIECES_MOST = 64;

/** The last `most` bytes of what was pushed, cut at a character, and whether anything was lost. */
const makeTail = (most: number) => {
  const kept: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }> = [];
  let total = 0;
  let truncated = false;
  return {
    push: (stream: "stdout" | "stderr", text: string) => {
      if (text === "") return;
      const bytes = Buffer.from(text, "utf8");
      const last = kept.at(-1);
      // One piece per run of a stream, not one per read.
      if (last !== undefined && last.stream === stream)
        last.bytes = Buffer.concat([last.bytes, bytes]);
      else kept.push({ stream, bytes });
      total += bytes.length;
      // Past the most, the two oldest pieces become one, under the later stream's name: the
      // order between them is lost, and the result says so.
      while (kept.length > OUTPUT_PIECES_MOST) {
        const [first, second] = kept;
        if (first === undefined || second === undefined) break;
        kept.splice(0, 2, {
          stream: second.stream,
          bytes: Buffer.concat([first.bytes, second.bytes]),
        });
        truncated = true;
      }
      for (let first = kept[0]; first !== undefined && total > most; first = kept[0]) {
        truncated = true;
        const over = total - most;
        if (first.bytes.length <= over) {
          kept.shift();
          total -= first.bytes.length;
          continue;
        }
        // Cut inside the oldest piece, forward to the start of a character.
        let from = over;
        while (from < first.bytes.length && ((first.bytes[from] ?? 0) & 0xc0) === 0x80) from += 1;
        total -= from;
        first.bytes = first.bytes.subarray(from);
        break;
      }
    },
    lost: () => {
      truncated = true;
    },
    take: (): { output: Array<CommandOutput>; truncated: boolean } => {
      const output: Array<CommandOutput> = [];
      for (const { stream, bytes } of kept) {
        const text = bytes.toString("utf8");
        for (let at = 0; at < text.length;) {
          let to = Math.min(text.length, at + DEVICE_OUTPUT_EVENT_MAX);
          // Never between the two halves of one character.
          const last = text.charCodeAt(to - 1);
          if (to < text.length && last >= 0xd800 && last <= 0xdbff) to -= 1;
          output.push({ stream, text: text.slice(at, to) });
          at = to;
        }
      }
      return { output, truncated };
    },
  };
};

const stopTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try {
    // The group, so what the command started goes with it.
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};

export const runCommand = (
  request: CommandRequest,
  timing: Timing = { killAfterMs: KILL_AFTER_MS, drainAfterExitMs: DRAIN_AFTER_EXIT_MS },
): Promise<CommandResult> =>
  new Promise((done, fail) => {
    if (process.platform === "win32") {
      fail(new Error("Commands aren't run on this system yet."));
      return;
    }
    if (request.signal.aborted) {
      done({ output: [], truncated: false, timedOut: false, stopped: true });
      return;
    }
    // Node reports a missing working folder as a missing shell.
    if (!existsSync(request.cwd)) {
      fail(new Error("The working folder is gone."));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", request.command], {
        cwd: request.cwd,
        // Exactly this environment: nothing of the app's own leaks in.
        env: shellEnvironment(request.env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const tail = makeTail(DEVICE_OUTPUT_MAX_BYTES);
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const ends: Array<() => void> = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      const redactor = makeRedactor(request.secrets);
      child[stream]?.on("data", (chunk: Buffer) => {
        tail.push(stream, redactor.push(decoder.write(chunk)));
      });
      ends.push(() => tail.push(stream, redactor.push(decoder.end()) + redactor.end()));
    }
    /** The shell has been collected: its number is free, so its group is never signalled again. */
    let exited = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!exited) stopTree(child, signal);
    };
    const stop = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), timing.killAfterMs);
    };
    const onAbort = () => {
      stopped = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, deviceTimeout(request.timeoutMs));
    request.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      request.signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      // Output still unread when the pipes are cut is lost, and the result says so.
      if ((child.stdout?.readableLength ?? 0) > 0 || (child.stderr?.readableLength ?? 0) > 0)
        tail.lost();
      child.stdout?.destroy();
      child.stderr?.destroy();
      for (const end of ends) end();
      const { output, truncated } = tail.take();
      done({
        output,
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
        truncated,
        timedOut,
        stopped,
      });
    };
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      fail(error);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // What the command left in its group goes now, in the same step as Node collecting the
      // shell, and never later: after this the number may be given to another process.
      stopTree(child, "SIGKILL");
      exited = true;
      // A background process may hold the pipes open; it gets a moment, not for ever.
      drainTimer = setTimeout(() => finish(code, signal), timing.drainAfterExitMs);
    });
    child.on("close", (code, signal) => finish(exit?.code ?? code, exit?.signal ?? signal));
  });
