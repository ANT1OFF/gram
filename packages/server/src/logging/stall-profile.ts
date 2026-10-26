// Names the code behind an event-loop stall. After a long one the server samples its own stack
// for a while, through V8's profiler on an inspector session to itself, and each later stall gets
// the call path that ran through it. Only function names and `file:line` are kept, never values.

import * as Effect from "effect/Effect";
import { basename } from "node:path";
import type { Profiler } from "node:inspector";

/** How often the profiler samples the stack while armed, in microseconds. */
const SAMPLE_INTERVAL_US = 10_000;

/** The most frames a stall's call path keeps, nearest the work first. */
const PATH_FRAMES = 12;

const IDLE = "(idle)";

const frameText = (frame: Profiler.ProfileNode["callFrame"]): string => {
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
  if (frame.url === "") return name;
  const file = basename(frame.url.replace(/^file:\/\//, ""));
  return `${name} ${file}:${frame.lineNumber + 1}`;
};

/** What ran through the longest stretch of a profile in which the loop never went idle. */
export interface BlockingStack {
  /** How long that stretch was. */
  readonly ms: number;
  /** The frames on the stack for at least half of it, outermost first, cut to the innermost few. */
  readonly path: ReadonlyArray<string>;
  /** The frame most often on top of the stack, i.e. doing the work itself. */
  readonly hottest: string | undefined;
}

/** `undefined` for a profile with no samples, or none that weren't idle. */
export const blockingStack = (profile: Profiler.Profile): BlockingStack | undefined => {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);

  // Each sample's delta is the time since the one before, so a sample stands for the delta after it.
  let best = { from: 0, to: 0, us: 0 };
  let from = 0;
  let us = 0;
  for (let index = 0; index <= samples.length; index += 1) {
    const node = index < samples.length ? nodes.get(samples[index]!) : undefined;
    if (node === undefined || node.callFrame.functionName === IDLE) {
      if (us > best.us) best = { from, to: index, us };
      from = index + 1;
      us = 0;
      continue;
    }
    us += deltas[index + 1] ?? 0;
  }
  if (best.to <= best.from) return undefined;

  // Weighted by the time each sample stands for, like the stretch itself: one sample can stand
  // for a whole second the sampler was held off, and five beside it for 10 ms each.
  const inclusive = new Map<number, number>();
  const self = new Map<number, number>();
  for (let index = best.from; index < best.to; index += 1) {
    const leaf = samples[index]!;
    const weight = deltas[index + 1] ?? 0;
    self.set(leaf, (self.get(leaf) ?? 0) + weight);
    for (let id: number | undefined = leaf; id !== undefined; id = parents.get(id)) {
      inclusive.set(id, (inclusive.get(id) ?? 0) + weight);
    }
  }
  const path: Array<string> = [];
  // The frames held through most of the stretch form one chain from the root; follow it down.
  for (let id: number | undefined = profile.nodes[0]?.id; id !== undefined;) {
    const node: Profiler.ProfileNode | undefined = nodes.get(id);
    if (node === undefined) break;
    if (parents.has(id)) path.push(frameText(node.callFrame));
    id = (node.children ?? []).find((child) => (inclusive.get(child) ?? 0) * 2 >= best.us);
  }
  const [hottest] = [...self].toSorted((a, b) => b[1] - a[1]);
  const hottestNode = hottest === undefined ? undefined : nodes.get(hottest[0]);
  return {
    ms: Math.round(best.us / 1000),
    path: path.slice(-PATH_FRAMES),
    hottest: hottestNode === undefined ? undefined : frameText(hottestNode.callFrame),
  };
};

/** The server's own sampling profiler, started and stopped a window at a time. */
interface StallProfiler {
  readonly start: Effect.Effect<void>;
  /** The samples since `start`, and the profiler stopped; `undefined` when it wasn't running. */
  readonly stop: Effect.Effect<Profiler.Profile | undefined>;
}

/**
 * A profiler over an inspector session to this process, or `undefined` when this runtime has no
 * inspector. Closed with its scope.
 */
export const makeStallProfiler = Effect.gen(function* () {
  const inspector = yield* Effect.tryPromise(() => import("node:inspector/promises")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (inspector === undefined) return undefined;
  const session = yield* Effect.acquireRelease(
    Effect.try(() => {
      const created = new inspector.Session();
      created.connect();
      return created;
    }),
    (created) => Effect.sync(() => created.disconnect()),
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (session === undefined) return undefined;
  let running = false;
  const profiler: StallProfiler = {
    start: Effect.tryPromise(async () => {
      if (running) return;
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
      await session.post("Profiler.start");
      running = true;
    }).pipe(Effect.ignore),
    stop: Effect.tryPromise(async () => {
      if (!running) return undefined;
      running = false;
      const { profile } = await session.post("Profiler.stop");
      await session.post("Profiler.disable");
      return profile;
    }).pipe(Effect.orElseSucceed(() => undefined)),
  };
  return profiler;
});
