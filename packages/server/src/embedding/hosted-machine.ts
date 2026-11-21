import { hostedMachineDown, hostedMachineReady, type HostedMachine } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { SentWorkPortShape } from "./sent-work-port.ts";

/** Where a start of the person's machine stands, as New task shows it. */
export type HostedMachineProgress =
  | { readonly state: "unoffered" }
  | { readonly state: "starting"; readonly phase: string }
  | { readonly state: "ready"; readonly phase: string }
  | { readonly state: "failed"; readonly why: string };

export interface EnsureHostedMachineOptions {
  /** How often it is read while it starts. */
  readonly every?: Duration.Input;
  /** How long a start may take before it is given up on: a new machine takes a minute or two. */
  readonly within?: Duration.Input;
  /** How long it may read as down after the start was asked before that is its answer. */
  readonly settle?: Duration.Input;
  /** Each reading, as it comes. */
  readonly onProgress?: (progress: HostedMachineProgress) => Effect.Effect<void>;
}

const EVERY = Duration.seconds(3);
const WITHIN = Duration.minutes(10);
const SETTLE = Duration.seconds(30);

const askMachine = (
  port: Pick<SentWorkPortShape, "machine">,
  target: { readonly origin: string; readonly workspaceId: string },
  action: "get" | "start",
) => port.machine(target.origin, target.workspaceId, action);

const progressOf = (machine: HostedMachine): HostedMachineProgress =>
  hostedMachineReady(machine)
    ? { state: "ready", phase: machine.phase }
    : { state: "starting", phase: machine.phase };

/**
 * Starts the person's own machine in `workspaceId` on `origin`, unless it runs, and waits until it
 * does. Answers `ready`, `unoffered` (the server starts none from here), or `failed` with why.
 * Safe to call again: a start of a machine that runs, or is starting, changes nothing there.
 */
export const ensureHostedMachine = (
  port: Pick<SentWorkPortShape, "machine">,
  target: { readonly origin: string; readonly workspaceId: string },
  options: EnsureHostedMachineOptions = {},
): Effect.Effect<Exclude<HostedMachineProgress, { readonly state: "starting" }>, never, never> =>
  Effect.gen(function* () {
    const said = options.onProgress ?? (() => Effect.void);
    const every = Duration.fromInputUnsafe(options.every ?? EVERY);
    const within = Duration.toMillis(Duration.fromInputUnsafe(options.within ?? WITHIN));
    const settle = Duration.toMillis(Duration.fromInputUnsafe(options.settle ?? SETTLE));

    const first = yield* askMachine(port, target, "get");
    if (!first.ok) return { state: "failed", why: first.why } as const;
    if (first.machine === "unoffered") return { state: "unoffered" } as const;
    if (hostedMachineReady(first.machine)) {
      const ready = { state: "ready", phase: first.machine.phase } as const;
      yield* said(ready);
      return ready;
    }
    const startsAlready = first.machine.starting === true || !hostedMachineDown(first.machine);
    const asked = startsAlready ? first : yield* askMachine(port, target, "start");
    if (!asked.ok) return { state: "failed", why: asked.why } as const;
    if (asked.machine === "unoffered") return { state: "unoffered" } as const;
    const startedAt = yield* Clock.currentTimeMillis;
    let latest = asked.machine;
    while (true) {
      const now = progressOf(latest);
      yield* said(now);
      if (now.state === "ready") return now;
      const waited = (yield* Clock.currentTimeMillis) - startedAt;
      if (latest.phase === "failed" && latest.starting !== true)
        return { state: "failed", why: "Your machine there failed to start." } as const;
      if (hostedMachineDown(latest) && waited > settle)
        return { state: "failed", why: "Your machine there didn't start." } as const;
      if (waited > within)
        return {
          state: "failed",
          why: `Your machine there isn't running after ${Math.round(within / 60_000)} minutes.`,
        } as const;
      yield* Effect.sleep(every);
      const next = yield* askMachine(port, target, "get");
      if (!next.ok) return { state: "failed", why: next.why } as const;
      if (next.machine === "unoffered") return { state: "unoffered" } as const;
      latest = next.machine;
    }
  });
