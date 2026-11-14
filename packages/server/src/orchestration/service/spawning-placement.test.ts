import { describe, expect, it } from "@effect/vitest";
import { HostId, LOCAL_HOST_ID, type Thread } from "@gram/contracts";
import { orchestratorsMachine } from "./spawning.ts";

// Where a headless Gram puts a worker that names no machine. The default machine is whichever
// joined first, which may be a machine started for other work (another run's sandbox), so a
// worker never goes there: it stays on its orchestrator's machine.
const at = (hostId: string | undefined, current?: string) =>
  ({
    checkout: { kind: "worktree", path: "/w", ...(hostId === undefined ? {} : { hostId }) },
    ...(current === undefined
      ? {}
      : { currentCheckout: { kind: "worktree", path: "/c", hostId: HostId.make(current) } }),
  }) as unknown as Pick<Thread, "checkout" | "currentCheckout">;

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
