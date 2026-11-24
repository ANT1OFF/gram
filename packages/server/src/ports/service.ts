import {
  effectiveCheckout,
  hostOf,
  LOCAL_HOST_ID,
  type TerminalProcess,
  type ThreadId,
} from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventHub } from "../events/event-hub.ts";
import { AppActivity, pollWhileShown } from "../git/activity.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { redactText } from "../logging/redact.ts";
import { foregroundOf, portsByKey, samePorts, shortCommand } from "./pure.ts";
import { ProcessRoots } from "./roots.ts";
import { liveScan, type PortScan } from "./scan.ts";

export { liveScan, type PortScan } from "./scan.ts";
export { ProcessRoots, type ProcessRootsShape } from "./roots.ts";

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
  /**
   * Whether a terminal of the thread runs a command right now on the machine the thread is on, from
   * a scan of that machine's own; undefined when that can't be told, so nothing is ruled out.
   */
  readonly terminalBusyNow: (threadId: ThreadId) => Effect.Effect<boolean | undefined>;
}

export interface ThreadPortsOptions {
  readonly scan?: Effect.Effect<PortScan, unknown, Proc>;
  readonly interval?: Duration.Input;
  /**
   * For a thread on another machine, whether its terminals run a command there (`undefined` when
   * that can't be told); `"here"` for a thread on this machine, which this machine's scan answers.
   */
  readonly elsewhere?: (threadId: ThreadId) => Effect.Effect<boolean | undefined | "here">;
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
        const firstSeen = new Map<string, number>();

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
                .map(({ threadId }) => threadId),
            ),
          ];
        });

        const elsewhere = options.elsewhere ?? (() => Effect.succeed("here" as const));
        const terminalBusyNow = (threadId: ThreadId) =>
          Effect.flatMap(elsewhere(threadId), (answer) =>
            answer === "here"
              ? Effect.map(busyTerminalsNow, (threads) => threads?.includes(threadId))
              : Effect.succeed(answer),
          );

        return ThreadPorts.of({
          portsOf: (threadId) => current.get(threadId) ?? [],
          terminalProcessesOf: (threadId) => busy.get(threadId) ?? [],
          refresh,
          busyTerminalsNow,
          terminalBusyNow,
        });
      }),
    );

  /**
   * Over this machine's host's scan, so the chips read the machine the threads run on. A thread on
   * another machine has its terminals read by that machine's host, and is never ruled at rest while
   * the machine can't be asked.
   */
  static readonly layer: Layer.Layer<
    ThreadPorts,
    never,
    ThreadRuntimes | EventHub | ProcessRoots | Proc | WorkerHosts
  > = Layer.unwrap(
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      const store = yield* Effect.serviceOption(ThreadStore);
      type Answer = boolean | undefined | "here";
      const elsewhere = (threadId: ThreadId): Effect.Effect<Answer> =>
        store._tag === "None"
          ? Effect.succeed("here")
          : store.value.getThread(threadId).pipe(
              Effect.map((thread) => hostOf(effectiveCheckout(thread))),
              Effect.orElseSucceed(() => LOCAL_HOST_ID),
              Effect.flatMap((id): Effect.Effect<Answer> =>
                id === LOCAL_HOST_ID
                  ? Effect.succeed("here")
                  : hosts.get(id).pipe(
                      Effect.flatMap(
                        (host): Effect.Effect<Answer> =>
                          host.ports.terminalBusy?.(threadId) ?? Effect.succeed(undefined),
                      ),
                      Effect.orElseSucceed((): Answer => undefined),
                    ),
              ),
            );
      return ThreadPorts.layerWith({ scan: hosts.local.ports.scan, elsewhere });
    }),
  );
}
