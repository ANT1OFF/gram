import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { blockingStack, makeStallProfiler } from "./stall-profile.ts";

/** A delay of the server's event loop at least this long gets a warning line. */
const LOOP_STALL_WARN_MS = 500;

/** How often the delay histogram is read and reset, so at most one line per window. */
const LOOP_STALL_WINDOW = Duration.seconds(10);

/** How many windows pass between two `event loop` lines, stalled or not: one every 10 minutes. */
const LOOP_HEARTBEAT_WINDOWS = 60;

/** A stall at least this long arms the stack profiler, so the ones after it are named. */
const PROFILE_ARM_MS = 1000;

/** How long the profiler stays armed after the last stall that armed it: stalls come in runs. */
const PROFILE_ARMED_WINDOWS = 180;

/** What one window measured, in milliseconds except the two sizes. */
export interface LoopWindow {
  readonly maxMs: number;
  readonly p99Ms: number;
  /** Callback time from ELU, or null when the embedder has no usable loop metrics. */
  readonly busyMs: number | null;
  /** User plus system CPU the process used. */
  readonly cpuMs: number;
  /** Time spent in garbage collection, and its longest single pause. */
  readonly gcMs: number;
  readonly gcMaxMs: number;
  readonly heapMb: number;
  readonly rssMb: number;
}

/**
 * What a long delay most likely was, from what else the window measured:
 * - `gc`: one collection paused about as long as the delay;
 * - `cpu`: the loop was busy and the process on a CPU for about that long, so JavaScript or a
 *   synchronous native call (SQLite, `fs.*Sync`) ran that long;
 * - `blocked`: the loop was busy but the process mostly off-CPU, as in a synchronous wait on the
 *   disk, a lock or memory paged back in;
 * - `suspended`: the loop was idle, so the process wasn't scheduled at all (sleep, App Nap);
 * - `unknown`: the embedder provides no ELU, so low CPU cannot distinguish blocking from sleep.
 */
export type LoopStallCause = "gc" | "cpu" | "blocked" | "suspended" | "unknown";

export const stallCause = (window: LoopWindow): LoopStallCause => {
  const delay = window.maxMs;
  if (window.gcMaxMs >= delay / 2) return "gc";
  if (window.busyMs === null) return window.cpuMs >= delay / 2 ? "cpu" : "unknown";
  if (window.busyMs < delay / 2) return "suspended";
  return window.cpuMs >= delay / 2 ? "cpu" : "blocked";
};

const rounded = (window: LoopWindow): LoopWindow => ({
  maxMs: Math.round(window.maxMs),
  p99Ms: Math.round(window.p99Ms),
  busyMs: window.busyMs === null ? null : Math.round(window.busyMs),
  cpuMs: Math.round(window.cpuMs),
  gcMs: Math.round(window.gcMs),
  gcMaxMs: Math.round(window.gcMaxMs),
  heapMb: Math.round(window.heapMb),
  rssMb: Math.round(window.rssMb),
});

/** What a window's warning carries, or `undefined` when nothing in it was delayed that long. */
export const loopStall = (
  window: LoopWindow,
  thresholdMs: number = LOOP_STALL_WARN_MS,
): (LoopWindow & { readonly cause: LoopStallCause }) | undefined =>
  window.maxMs < thresholdMs ? undefined : { ...rounded(window), cause: stallCause(window) };

const MB = 1024 * 1024;

/**
 * Electron 44's utilityProcess does not set Node's loopStart milestone, and ELU returns zeros.
 * Its externally pumped loop may also lack idle accounting; zero total time is not measured idle.
 */
export const measuredBusyMs = (
  used: ReturnType<typeof performance.eventLoopUtilization>,
  loopStart: number,
): number | null => (loopStart < 0 || used.active + used.idle <= 0 ? null : used.active);

/**
 * Warns when the event loop was blocked, which delays every request on every socket behind it. One
 * process serves every window, so a stall reads as the app hanging; this makes it a log line with
 * a time and a likely cause on it, and an `event loop` line every ten minutes says the
 * loop was turning when nothing stalled. A stall past `PROFILE_ARM_MS` arms the stack profiler for
 * half an hour, and each stall in that time names the code it ran (`stall-profile.ts`). Timings,
 * sizes and function names only.
 */
export const LoopStallLog: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const histogram = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const created = monitorEventLoopDelay({ resolution: 20 });
        created.enable();
        return created;
      }),
      (created) => Effect.sync(() => created.disable()),
    );
    const gc = { totalMs: 0, maxMs: 0 };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            gc.totalMs += entry.duration;
            gc.maxMs = Math.max(gc.maxMs, entry.duration);
          }
        });
        observer.observe({ entryTypes: ["gc"] });
        return observer;
      }),
      (observer) => Effect.sync(() => observer.disconnect()),
    );
    const profiler = yield* makeStallProfiler;
    let armedUntil = 0;
    let utilization = performance.eventLoopUtilization();
    let cpu = process.cpuUsage();
    let windows = 0;
    yield* Effect.gen(function* () {
      yield* Effect.sleep(LOOP_STALL_WINDOW);
      const nextUtilization = performance.eventLoopUtilization();
      const nextCpu = process.cpuUsage();
      const used = performance.eventLoopUtilization(nextUtilization, utilization);
      const spent = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      const window: LoopWindow = {
        maxMs: histogram.max / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        busyMs: measuredBusyMs(used, performance.nodeTiming.loopStart),
        cpuMs: (spent.user + spent.system) / 1000,
        gcMs: gc.totalMs,
        gcMaxMs: gc.maxMs,
        heapMb: memory.heapUsed / MB,
        rssMb: memory.rss / MB,
      };
      histogram.reset();
      gc.totalMs = 0;
      gc.maxMs = 0;
      utilization = nextUtilization;
      cpu = nextCpu;
      windows += 1;
      const windowMs = Duration.toMillis(LOOP_STALL_WINDOW);
      const stall = loopStall(window);
      const profile = profiler === undefined ? undefined : yield* profiler.stop;
      if (profiler !== undefined && stall !== undefined && stall.maxMs >= PROFILE_ARM_MS) {
        armedUntil = windows + PROFILE_ARMED_WINDOWS;
      }
      if (profiler !== undefined && windows < armedUntil) yield* profiler.start;
      if (stall !== undefined) {
        const stack = profile === undefined ? undefined : blockingStack(profile);
        yield* Effect.logWarning("event loop stalled").pipe(
          Effect.annotateLogs({ ...stall, windowMs, ...(stack === undefined ? {} : { stack }) }),
        );
      } else if (windows % LOOP_HEARTBEAT_WINDOWS === 0) {
        yield* Effect.logInfo("event loop").pipe(
          Effect.annotateLogs({ ...rounded(window), windowMs }),
        );
      }
    }).pipe(Effect.forever, Effect.forkScoped);
  }),
);
