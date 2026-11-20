import { describe, expect, it } from "@effect/vitest";
import type { HostedMachine } from "@gram/contracts";
import * as Effect from "effect/Effect";

import { ensureHostedMachine, type HostedMachineProgress } from "./hosted-machine.ts";
import type { SentWorkPortShape } from "./sent-work-port.ts";

type Answer =
  | { readonly ok: true; readonly machine: HostedMachine | "unoffered" }
  | { readonly ok: false; readonly why: string };

/** The desktop app's answers about the person's machine there: one per read, the last kept. */
const appAnswering = (
  reads: ReadonlyArray<Answer>,
  start: Answer = { ok: true, machine: { phase: "none", starting: true } },
) => {
  const asked: Array<"get" | "start"> = [];
  let next = 0;
  const port: Pick<SentWorkPortShape, "machine"> = {
    machine: (_origin, _workspaceId, action) =>
      Effect.sync(() => {
        asked.push(action);
        if (action === "start") return start;
        const answer = reads[Math.min(next, reads.length - 1)]!;
        next += 1;
        return answer;
      }),
  };
  return { port, asked };
};

const target = { origin: "https://hosted.example.com", workspaceId: "w1" };
const quick = { every: 1, settle: 20, within: 2_000 };
const machine = (phase: string, starting = false): Answer => ({
  ok: true,
  machine: { phase, starting },
});

describe("starting the person's own machine for a send", () => {
  it.live("starts one that isn't running, and answers once it runs", () =>
    Effect.gen(function* () {
      const { port, asked } = appAnswering([
        machine("none"),
        machine("pending", true),
        machine("running", true),
        machine("running"),
      ]);
      const seen: HostedMachineProgress[] = [];
      const ended = yield* ensureHostedMachine(port, target, {
        ...quick,
        onProgress: (progress) => Effect.sync(() => void seen.push(progress)),
      });
      expect(ended).toEqual({ state: "ready", phase: "running" });
      expect(asked.filter((action) => action === "start")).toHaveLength(1);
      // Running while its start is still under way isn't ready: its host may not have joined yet.
      expect(seen.map((each) => each.state)).toEqual(["starting", "starting", "starting", "ready"]);
    }),
  );

  it.live("never starts one that runs, or one already starting", () =>
    Effect.gen(function* () {
      const running = appAnswering([machine("running")]);
      expect(yield* ensureHostedMachine(running.port, target, quick)).toEqual({
        state: "ready",
        phase: "running",
      });
      const starting = appAnswering([machine("starting", true), machine("running")]);
      expect(yield* ensureHostedMachine(starting.port, target, quick)).toMatchObject({
        state: "ready",
      });
      expect([...running.asked, ...starting.asked]).not.toContain("start");
    }),
  );

  it.live("asks nothing more of a server that starts no machine from here", () =>
    Effect.gen(function* () {
      const { port, asked } = appAnswering([{ ok: true, machine: "unoffered" }]);
      expect(yield* ensureHostedMachine(port, target, quick)).toEqual({ state: "unoffered" });
      expect(asked).toEqual(["get"]);
    }),
  );

  it.live("says why when the server refuses the start, or the machine never comes up", () =>
    Effect.gen(function* () {
      const refused = appAnswering([machine("none")], {
        ok: false,
        why: "Your organisation allows no sandboxes.",
      });
      expect(yield* ensureHostedMachine(refused.port, target, quick)).toEqual({
        state: "failed",
        why: "Your organisation allows no sandboxes.",
      });
      const failed = appAnswering([machine("none"), machine("failed")]);
      expect(yield* ensureHostedMachine(failed.port, target, quick)).toMatchObject({
        state: "failed",
      });
      // Down well past the start, with no start under way: this start isn't bringing it up.
      const gone = appAnswering([machine("none")], machine("none"));
      expect(yield* ensureHostedMachine(gone.port, target, quick)).toEqual({
        state: "failed",
        why: "Your machine there didn't start.",
      });
    }),
  );
});
