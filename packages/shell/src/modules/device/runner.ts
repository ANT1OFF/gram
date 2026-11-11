import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { DEVICE_OUTPUT_EVENT_MAX, DEVICE_OUTPUT_MAX_BYTES, deviceTimeout } from "@gram/contracts";
import { makeRedactor } from "./environment.ts";

/**
 * Runs one allowed command on a lent machine. `/bin/sh -c` with no start-up files, no stdin and
 * no terminal, in a process group of its own so the whole tree can be stopped. The output is
 * redacted as it arrives, kept to its last `DEVICE_OUTPUT_MAX_BYTES` and handed over when the
 * command has ended: keeping the end means nothing can be sent before the end is known.
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

/** The last `most` bytes of what was pushed, cut at a character, and whether anything was lost. */
const makeTail = (most: number) => {
  const kept: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }> = [];
  let total = 0;
  let truncated = false;
  return {
    push: (stream: "stdout" | "stderr", text: string) => {
      if (text === "") return;
      const bytes = Buffer.from(text, "utf8");
      kept.push({ stream, bytes });
      total += bytes.length;
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
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", request.command], {
        cwd: request.cwd,
        // Exactly this environment: nothing of the app's own leaks in.
        env: { ...request.env },
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
    const stop = () => {
      stopTree(child, "SIGTERM");
      killTimer ??= setTimeout(() => stopTree(child, "SIGKILL"), timing.killAfterMs);
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
      // Whatever the command left running goes too: nothing outlives its ask.
      stopTree(child, "SIGKILL");
      clearTimeout(killTimer);
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
      // A background process may hold the pipes open; it gets a moment, not for ever.
      drainTimer = setTimeout(() => finish(code, signal), timing.drainAfterExitMs);
    });
    child.on("close", (code, signal) => finish(exit?.code ?? code, exit?.signal ?? signal));
  });
