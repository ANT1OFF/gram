// Port chips: TCP ports listening inside each thread's process trees (its agent and its terminals),
// found by one machine-wide scan per poll and pushed as `thread.ports` events when they change. The
// same scan finds what runs in the foreground of each terminal, pushed as `thread.terminalProcesses`.

import type { TerminalId, TerminalProcess, ThreadId } from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { EventHub } from "../events/event-hub.ts";
import { AppActivity, pollWhileShown } from "../git/activity.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { redactText } from "../logging/redact.ts";
import {
  childrenOf,
  foregroundOf,
  portsByKey,
  samePorts,
  scanCommands,
  shortCommand,
  type Command,
  type ProcessRow,
} from "./pure.ts";

/** One sweep of the machine: listening ports by pid, and the process tree as ppid → children. */
export interface PortScan {
  readonly listening: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly children: ReadonlyMap<number, ReadonlyArray<number>>;
  /** Every process by pid, for what runs in the terminals; none found when left out. */
  readonly processes?: ReadonlyMap<number, ProcessRow>;
}

/** `lsof` + `ps`, or `netstat` + CIM on Windows. */
export const liveScan: Effect.Effect<PortScan, unknown, Proc> = Effect.gen(function* () {
  const proc = yield* Proc;
  const commands = scanCommands(process.platform);
  const run = (command: Command) =>
    proc.run(command.file, command.args, {
      cwd: homedir(),
      timeoutMs: 10_000,
      maxOutputBytes: 16_000_000,
    });
  const [listeners, processes] = yield* Effect.all(
    [run(commands.listeners), run(commands.processes)],
    { concurrency: 2 },
  );
  const rows = commands.parseProcesses(processes.stdout);
  return {
    listening: commands.parseListeners(listeners.stdout),
    children: childrenOf(rows),
    processes: rows,
  };
});

export interface ProcessRootsShape {
  add(threadId: ThreadId, pid: number, terminalId?: TerminalId): void;
  remove(pid: number): void;
  readonly all: Effect.Effect<ReadonlyArray<readonly [ThreadId, number]>>;
  /** The roots that are a terminal's shell, with the terminal. */
  readonly terminals: Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly pid: number;
      readonly terminalId: TerminalId;
    }>
  >;
}

/** Root pids a thread owns outside its agent session: its terminals' shells. */
export class ProcessRoots extends Context.Service<ProcessRoots, ProcessRootsShape>()(
  "@gram/server/ProcessRoots",
) {
  static readonly layer: Layer.Layer<ProcessRoots> = Layer.sync(ProcessRoots, () => {
    const rootOf = new Map<number, { threadId: ThreadId; terminalId?: TerminalId | undefined }>();
    return ProcessRoots.of({
      add: (threadId, pid, terminalId) => void rootOf.set(pid, { threadId, terminalId }),
      remove: (pid) => void rootOf.delete(pid),
      all: Effect.sync(() => [...rootOf].map(([pid, root]) => [root.threadId, pid] as const)),
      terminals: Effect.sync(() =>
        [...rootOf].flatMap(([pid, { threadId, terminalId }]) =>
          terminalId === undefined ? [] : [{ threadId, pid, terminalId }],
        ),
      ),
    });
  });
}

export interface ThreadPortsShape {
  /** The thread's ports as of the last scan; empty when none or unknown. */
  portsOf(threadId: ThreadId): ReadonlyArray<number>;
  /** What runs in the thread's terminals as of the last scan; empty when nothing does. */
  terminalProcessesOf(threadId: ThreadId): ReadonlyArray<TerminalProcess>;
  /** Scans and publishes changes. A failed scan keeps the last known ports. */
  readonly refresh: Effect.Effect<void>;
  /**
   * The threads whose terminal runs a foreground command right now, from a scan of its own rather
   * than the last periodic one; undefined when that scan fails, since then nothing is ruled out.
   */
  readonly busyTerminalsNow: Effect.Effect<ReadonlyArray<ThreadId> | undefined>;
}

export interface ThreadPortsOptions {
  readonly scan?: Effect.Effect<PortScan, unknown, Proc>;
  readonly interval?: Duration.Input;
}

export class ThreadPorts extends Context.Service<ThreadPorts, ThreadPortsShape>()(
  "@gram/server/ThreadPorts",
) {
  static readonly layerWith = (
    options: ThreadPortsOptions = {},
  ): Layer.Layer<ThreadPorts, never, ThreadRuntimes | EventHub | ProcessRoots | Proc> =>
    Layer.effect(
      ThreadPorts,
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const hub = yield* EventHub;
        const roots = yield* ProcessRoots;
        const scan = (options.scan ?? liveScan).pipe(Effect.provideService(Proc, yield* Proc));
        const current = new Map<string, ReadonlyArray<number>>();
        const busy = new Map<string, ReadonlyArray<TerminalProcess>>();
        /** When each terminal's foreground process was first seen, by `terminalId:pid`. */
        const firstSeen = new Map<string, number>();

        /** Each thread's busy terminals in `scan`, and publishes the threads whose list changed. */
        const publishTerminals = (swept: PortScan | undefined) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const next = new Map<string, Array<TerminalProcess>>();
            const seen = new Set<string>();
            for (const { threadId, pid, terminalId } of yield* roots.terminals) {
              const job =
                swept?.processes === undefined
                  ? undefined
                  : foregroundOf(swept.processes, swept.children, pid);
              if (job === undefined) continue;
              const key = `${terminalId}:${job.pid}`;
              seen.add(key);
              const startedAt = firstSeen.get(key) ?? now;
              firstSeen.set(key, startedAt);
              next.set(threadId, [
                ...(next.get(threadId) ?? []),
                // Scrubbed like a log line, and whole: clipped first, a key's head could slip past
                // the patterns. The second pass is for anything the shortening itself exposes.
                {
                  terminalId,
                  pid: job.pid,
                  command: redactText(shortCommand(redactText(job.command))),
                  startedAt,
                },
              ]);
            }
            for (const key of firstSeen.keys()) if (!seen.has(key)) firstSeen.delete(key);
            for (const threadId of new Set([...busy.keys(), ...next.keys()])) {
              const processes = next.get(threadId) ?? [];
              if (JSON.stringify(busy.get(threadId) ?? []) === JSON.stringify(processes)) continue;
              if (processes.length === 0) busy.delete(threadId);
              else busy.set(threadId, processes);
              yield* hub.publish({
                type: "thread.terminalProcesses",
                threadId: threadId as ThreadId,
                processes,
              });
            }
          });

        const refresh = Effect.gen(function* () {
          const byThread = new Map<string, Array<number>>();
          for (const [threadId, pid] of [...(yield* runtimes.processIds), ...(yield* roots.all)]) {
            byThread.set(threadId, [...(byThread.get(threadId) ?? []), pid]);
          }
          // Nothing to attribute: skip the scan, but still clear chips of threads that stopped.
          const swept = byThread.size === 0 ? undefined : yield* scan;
          const next =
            swept === undefined
              ? new Map<string, Array<number>>()
              : portsByKey(byThread, swept.listening, swept.children);
          for (const threadId of new Set([...current.keys(), ...next.keys()])) {
            const ports = next.get(threadId) ?? [];
            if (samePorts(current.get(threadId) ?? [], ports)) continue;
            if (ports.length === 0) current.delete(threadId);
            else current.set(threadId, ports);
            yield* hub.publish({ type: "thread.ports", threadId: threadId as ThreadId, ports });
          }
          yield* publishTerminals(swept);
        }).pipe(Effect.ignore);

        // The chips are the window's alone, and each scan runs `lsof` and `ps` over the whole
        // machine, so the scan rests while no window shows and slows while none is focused.
        yield* pollWhileShown(
          yield* Effect.serviceOption(AppActivity),
          options.interval ?? "5 seconds",
          refresh,
        ).pipe(Effect.forkScoped);
        const busyTerminalsNow = Effect.gen(function* () {
          const terminals = yield* roots.terminals;
          if (terminals.length === 0) return [];
          const swept = yield* scan.pipe(Effect.orElseSucceed(() => undefined));
          if (swept?.processes === undefined) return undefined;
          const { processes, children } = swept;
          return [
            ...new Set(
              terminals
                .filter(({ pid }) => foregroundOf(processes, children, pid) !== undefined)
                .map(({ threadId }) => threadId as ThreadId),
            ),
          ];
        });

        return ThreadPorts.of({
          portsOf: (threadId) => current.get(threadId) ?? [],
          terminalProcessesOf: (threadId) => busy.get(threadId) ?? [],
          refresh,
          busyTerminalsNow,
        });
      }),
    );

  static readonly layer = ThreadPorts.layerWith();
}
