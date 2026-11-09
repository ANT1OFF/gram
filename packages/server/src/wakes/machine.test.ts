import { describe, expect, it } from "@effect/vitest";
import type { HostId, Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { machineSource, MachineState } from "./machine.ts";

const disks: Array<string> = [];
const FakeMachine = Layer.succeed(MachineState, {
  loadAverages: Effect.succeed([9, 9, 9] as const),
  cpus: 8,
  disk: (path) =>
    Effect.sync(() => {
      disks.push(path);
      return { free: 500e9, total: 1000e9 };
    }),
});

const callerOn = (hostId: HostId | undefined) =>
  ({
    checkout: {
      kind: "worktree",
      path: "/home/someone/.config/gram-host/repos/x/.worktrees/a",
      repoRoot: "/home/someone/.config/gram-host/repos/x",
      ...(hostId === undefined ? {} : { hostId }),
    },
  }) as unknown as Thread;

describe("machine wakes", () => {
  it.effect("refuses a thread on another machine, without reading this machine's disk", () =>
    Effect.gen(function* () {
      const source = yield* machineSource;
      disks.length = 0;
      const remote = callerOn("machine-b" as HostId);
      for (const spec of [
        { kind: "machine", metric: "diskFree", belowGB: 10 },
        { kind: "machine", metric: "load", below: 2 },
      ] as const) {
        const armed = yield* Effect.exit(source.arm(remote, spec as never));
        expect(Exit.isFailure(armed)).toBe(true);
        expect(JSON.stringify(armed)).toContain("runs on another one");
      }
      expect(disks).toEqual([]);
      // This machine's own threads still arm.
      const local = yield* source.arm(callerOn(undefined), {
        kind: "machine",
        metric: "diskFree",
        belowGB: 10,
      } as never);
      expect(local.spec).toMatchObject({ path: "/home/someone/.config/gram-host/repos/x" });
    }).pipe(Effect.provide(FakeMachine)),
  );
});
