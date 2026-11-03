/**
 * `machine`: this machine's own state, read in the server's process with no command run. `load` is
 * the 1-minute load average (`os.loadavg`), absolute as `uptime` shows it, staying below a number for
 * some minutes: for heavy checks to wait for a quiet machine. `diskFree` is the free space on the
 * volume holding a path (`fs.statfs`), the waiting thread's repo by default, dropping below some
 * GB: for cleanup to start before the disk fills.
 *
 * The kind polls every 30 seconds while a wake waits on it; a volume's free space is read at most
 * every five minutes. How long the load has stayed low is kept in memory, so a restart starts the
 * count again: the app can't say what the load was while it was down.
 */
import { statfs } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { isAbsolute } from "node:path";
import {
  AppToolError,
  MACHINE_LOAD_DEFAULT_MINUTES,
  type DiskFreeCondition,
  type MachineLoadCondition,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ConditionLook, WakeConditionSource } from "./conditions.ts";

export interface DiskSpace {
  /** Bytes an unprivileged process may still write. */
  readonly free: number;
  readonly total: number;
}

export interface MachineStateShape {
  /** The 1-, 5- and 15-minute load averages; `undefined` where the OS keeps none (Windows). */
  readonly loadAverages: Effect.Effect<readonly [number, number, number] | undefined>;
  readonly cpus: number;
  /** The space on the volume holding `path`; `undefined` when it can't be read. */
  readonly disk: (path: string) => Effect.Effect<DiskSpace | undefined>;
}

export class MachineState extends Context.Service<MachineState, MachineStateShape>()(
  "@gram/server/MachineState",
) {}

export const MachineStateLive = Layer.succeed(MachineState, {
  loadAverages: Effect.sync(() => {
    if (process.platform === "win32") return undefined;
    const [one = 0, five = 0, fifteen = 0] = loadavg();
    return [one, five, fifteen] as const;
  }),
  cpus: availableParallelism(),
  disk: (path) =>
    Effect.tryPromise(() => statfs(path)).pipe(
      Effect.map((fs): DiskSpace => ({
        free: Number(fs.bavail) * Number(fs.bsize),
        total: Number(fs.blocks) * Number(fs.bsize),
      })),
      Effect.orElseSucceed(() => undefined),
    ),
});

/** How long one volume's free space answers for every wake on it. */
const DISK_READ_EVERY_MS = 5 * 60_000;
const GB = 1e9;
const MAX_MINUTES = 24 * 60;

const refuse = (message: string) => new AppToolError({ tool: "schedule_wake", message });
const met = (facts: Readonly<Record<string, string>>): ConditionLook => ({ met: true, facts });
const gb = (bytes: number) => (bytes / GB).toFixed(1);

/**
 * Whether the load averages say it has been below `below` for `forMinutes` already: the averages
 * over at least that long all are. Beyond 15 minutes they can't say.
 */
const quietAlready = (
  [one, five, fifteen]: readonly [number, number, number],
  below: number,
  forMinutes: number,
) => {
  const over = forMinutes <= 1 ? [one] : forMinutes <= 5 ? [one, five] : [one, five, fifteen];
  return forMinutes <= 15 && over.every((load) => load < below);
};

export const machineSource = Effect.gen(function* () {
  const machine = yield* MachineState;
  /** Per wake id, since when every look has found the load below. */
  const belowSince = new Map<string, number>();
  const disks = new Map<string, { readonly at: number; readonly space: DiskSpace }>();

  const diskOf = (path: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const kept = disks.get(path);
      if (kept !== undefined && now - kept.at < DISK_READ_EVERY_MS) return kept.space;
      const space = yield* machine.disk(path);
      if (space !== undefined) disks.set(path, { at: now, space });
      return space;
    });

  const armLoad = (spec: MachineLoadCondition) =>
    Effect.gen(function* () {
      const forMinutes = spec.forMinutes ?? MACHINE_LOAD_DEFAULT_MINUTES;
      if (!Number.isFinite(spec.below) || spec.below <= 0) {
        return yield* refuse("`below` is a load above 0.");
      }
      if (!Number.isFinite(forMinutes) || forMinutes < 0 || forMinutes > MAX_MINUTES) {
        return yield* refuse("`forMinutes` is from 0 to 1440.");
      }
      const loads = yield* machine.loadAverages;
      if (loads === undefined) return yield* refuse("This machine keeps no load average.");
      if (quietAlready(loads, spec.below, forMinutes)) {
        return yield* refuse(
          `The load is below ${spec.below} already: ${loads.map((l) => l.toFixed(1)).join(", ")} over 1, 5 and 15 minutes.`,
        );
      }
      return { spec: { ...spec, forMinutes } };
    });

  const armDisk = (path: string | undefined, spec: DiskFreeCondition) =>
    Effect.gen(function* () {
      if (!Number.isFinite(spec.belowGB) || spec.belowGB <= 0) {
        return yield* refuse("`belowGB` is a size above 0.");
      }
      if (path === undefined || !isAbsolute(path)) {
        return yield* refuse("`path` is an absolute path.");
      }
      const space = yield* diskOf(path);
      if (space === undefined) return yield* refuse(`Can't read the free space at ${path}.`);
      if (space.free < spec.belowGB * GB) {
        return yield* refuse(
          `${gb(space.free)} GB is free at ${path} already, below ${spec.belowGB}.`,
        );
      }
      return { spec: { ...spec, path } };
    });

  const source: WakeConditionSource<"machine"> = {
    kind: "machine",
    pollEvery: Duration.seconds(30),
    // The load's hold is `forMinutes`, and free space doesn't flicker.
    debounce: Duration.zero,
    arm: (caller, spec) =>
      spec.metric === "load"
        ? armLoad(spec)
        : armDisk(spec.path ?? caller.checkout.repoRoot ?? caller.checkout.path, spec),
    look: (wake) =>
      Effect.gen(function* () {
        const spec = wake.spec;
        if (spec.metric === "diskFree") {
          if (spec.path === undefined) return undefined;
          const space = yield* diskOf(spec.path);
          if (space === undefined) return undefined;
          if (space.free >= spec.belowGB * GB) return { met: false };
          return met({
            metric: "diskFree",
            path: spec.path,
            freeGB: gb(space.free),
            belowGB: String(spec.belowGB),
            totalGB: gb(space.total),
          });
        }
        const loads = yield* machine.loadAverages;
        if (loads === undefined) return undefined;
        const [load] = loads;
        if (load >= spec.below) {
          belowSince.delete(wake.id);
          return { met: false };
        }
        const now = yield* Clock.currentTimeMillis;
        const since = belowSince.get(wake.id) ?? now;
        belowSince.set(wake.id, since);
        const forMinutes = spec.forMinutes ?? MACHINE_LOAD_DEFAULT_MINUTES;
        if (now - since < forMinutes * 60_000) return { met: false };
        belowSince.delete(wake.id);
        return met({
          metric: "load",
          load: load.toFixed(1),
          below: String(spec.below),
          for: `${forMinutes} min`,
          cpus: String(machine.cpus),
        });
      }),
  };
  return source;
});
