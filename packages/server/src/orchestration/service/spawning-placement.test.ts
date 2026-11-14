import { describe, expect, it } from "@effect/vitest";
import { HostId, LOCAL_HOST_ID, type Thread } from "@gram/contracts";
import {
  NOT_THIS_ORCHESTRATIONS_MACHINE,
  orchestratorsMachine,
  RUNS_ON_ITS_ORCHESTRATORS_MACHINE,
  workerMachine,
} from "./spawning.ts";

// Where a worker goes. The default machine is whichever joined first, and a machine named by an
// orchestrator may have been started for other work (another run's sandbox), so a worker stays on
// its orchestrator's machine, or one of the same person's own, and nowhere else.
const at = (hostId: string | undefined, current?: string) =>
  ({
    checkout: { kind: "worktree", path: "/w", ...(hostId === undefined ? {} : { hostId }) },
    ...(current === undefined
      ? {}
      : { currentCheckout: { kind: "worktree", path: "/c", hostId: HostId.make(current) } }),
  }) as unknown as Pick<Thread, "checkout" | "currentCheckout">;
const id = (value: string) => HostId.make(value);
const runA = id("m-run-a");
const runB = { id: id("m-run-b"), onDemand: "thread" as const };
const oldRunB = { id: id("m-run-b-old") };
const adaOwn = { id: id("m-ada"), owner: "ada", onDemand: "personal" as const };
const adaSecond = { id: id("m-ada-2"), owner: "ada", onDemand: "personal" as const };
const graceOwn = { id: id("m-grace"), owner: "grace", onDemand: "personal" as const };

describe("a worker that names no machine, in a headless Gram", () => {
  it("goes on its orchestrator's machine", () => {
    expect(orchestratorsMachine(at("m-run-a"))).toBe("m-run-a");
    // The checkout it works in now, where it moved.
    expect(orchestratorsMachine(at("m-run-a", "m-run-b"))).toBe("m-run-b");
  });

  it("takes the placement's machine only when its orchestrator runs on this one", () => {
    expect(orchestratorsMachine(at(undefined))).toBeUndefined();
    expect(orchestratorsMachine(at(LOCAL_HOST_ID))).toBeUndefined();
  });
});

describe("the machine an orchestrator names for a worker", () => {
  const headless = { own: runA, ownOwner: undefined, headless: true };

  it("is never another run's, marked or from before machines said their kind", () => {
    expect(workerMachine(runB, headless)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    expect(workerMachine(oldRunB, headless)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    // Nor a person's own machine, for a run that acts for no one.
    expect(workerMachine(adaOwn, headless)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    // Its own machine, named, is its own.
    expect(workerMachine({ id: runA, onDemand: "thread" }, headless)).toEqual({ hostId: runA });
  });

  it("is a person's own machine for their orchestrator, and no one else's", () => {
    const ada = { own: adaOwn.id, ownOwner: "ada", headless: true };
    expect(workerMachine(adaSecond, ada)).toEqual({ hostId: adaSecond.id });
    expect(workerMachine(graceOwn, ada)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    expect(workerMachine(runB, ada)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    expect(workerMachine(oldRunB, ada)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
  });

  it("takes 'here' on a headless Gram as its orchestrator's machine, never the default", () => {
    expect(workerMachine("here", headless)).toEqual({ hostId: runA });
    expect(workerMachine(undefined, headless)).toEqual({ hostId: runA });
    expect(workerMachine("here", { own: undefined, ownOwner: undefined, headless: true })).toEqual({
      error: RUNS_ON_ITS_ORCHESTRATORS_MACHINE,
    });
  });

  it("keeps a Gram that runs work itself as it was, short of another run's machine", () => {
    const desktop = { own: undefined, ownOwner: undefined, headless: false };
    expect(workerMachine("here", desktop)).toEqual({ hostId: undefined });
    expect(workerMachine(oldRunB, desktop)).toEqual({ hostId: oldRunB.id });
    expect(workerMachine(runB, desktop)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
    expect(workerMachine(graceOwn, desktop)).toEqual({ error: NOT_THIS_ORCHESTRATIONS_MACHINE });
  });
});
