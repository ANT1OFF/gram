// The one decision every placement on a workers' machine goes through, and the claim it is
// decided from: whose the machine is, kept with the machine.

import { describe, expect, it } from "vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMachineClaims, type MachineClaim } from "../embedding/worker-machine-claims.ts";
import { claimFromWorkers, decidePlacement } from "./worker-placement.ts";

const NAME = "worker-00000000aa";
const A = "t-a" as ThreadId;
const B = "t-b" as ThreadId;

const on = (id: string, by: ThreadId, placement?: object) =>
  ({
    id: id as ThreadId,
    title: `Worker ${id}`,
    checkout: { kind: "worktree", path: `/w/${id}`, hostId: "m-1" },
    spawnedBy: { threadId: by, feature: "f", ...(placement === undefined ? {} : { placement }) },
  }) as unknown as Thread;

const claim = (mode: MachineClaim["mode"], picks: Record<string, string> = {}): MachineClaim => ({
  orchestrator: A,
  mode,
  picks,
  at: 1,
});

const decide = (facts: Partial<Parameters<typeof decidePlacement>[0]>) => {
  const decided = decidePlacement({
    caller: A,
    machine: NAME,
    claim: undefined,
    as: "named",
    picks: {},
    on: [],
    coming: 0,
    cap: 4,
    now: 5,
    ...facts,
  });
  return decided.ok ? "ok" : decided.code;
};

describe("who may be placed on a workers' machine", () => {
  it("is decided from the machine's claim, whoever is on it", () => {
    // Nobody asked for it: only a spawn that asks for it now, with nobody there, gets it.
    expect(decide({ as: "own" })).toBe("ok");
    expect(decide({ as: "named" })).toBe("not_yours");
    expect(decide({ as: "own", on: [on("x", A)] })).toBe("not_yours");
    expect(decide({ as: "shared", coming: 1 })).toBe("not_yours");
    // Another orchestrator's: never, by any form, however many of the caller's workers sit there.
    for (const as of ["own", "exclusive", "shared", "named"] as const)
      expect(decide({ caller: B, as, claim: claim("shared"), on: [on("x", B), on("y", B)] })).toBe(
        "not_yours",
      );
    // Its own orchestrator's, while it carries a worker another took on: nobody is added.
    expect(decide({ claim: claim("shared"), on: [on("x", B)] })).toBe("other_orchestrator");
  });

  it("keeps an exclusive machine to its one worker, and a machine of its own to nobody else", () => {
    expect(decide({ as: "exclusive", claim: claim("exclusive") })).toBe("ok");
    expect(decide({ as: "exclusive", claim: claim("exclusive"), on: [on("x", A)] })).toBe(
      "exclusive",
    );
    expect(decide({ as: "exclusive", claim: claim("exclusive"), coming: 1 })).toBe("exclusive");
    for (const as of ["own", "shared", "named"] as const)
      expect(decide({ as, claim: claim("exclusive") })).toBe("exclusive");
    // A machine others may be placed on never becomes one worker's alone.
    expect(decide({ as: "exclusive", claim: claim("own") })).toBe("mode");
    expect(decide({ as: "exclusive", claim: claim("shared") })).toBe("mode");
    // "Its own" is a machine nobody is on, or on their way to.
    expect(decide({ as: "own", claim: claim("own") })).toBe("ok");
    expect(decide({ as: "own", claim: claim("own"), on: [on("x", A)] })).toBe("in_use");
    expect(decide({ as: "own", claim: claim("own"), coming: 1 })).toBe("in_use");
    expect(decide({ as: "own", claim: claim("shared") })).toBe("in_use");
    // The pool is the machines asked for as shared; one of its own is reached by name only.
    expect(decide({ as: "shared", claim: claim("own") })).toBe("mode");
    expect(decide({ as: "named", claim: claim("own"), on: [on("x", A)] })).toBe("ok");
  });

  it("holds every form to the picks the machine was asked with, and to its cap", () => {
    const data = claim("shared", { environment: "data" });
    expect(decide({ as: "shared", claim: data, picks: { environment: "data" } })).toBe("ok");
    expect(decide({ as: "shared", claim: data })).toBe("picks");
    expect(decide({ as: "shared", claim: data, picks: { environment: "web" } })).toBe("picks");
    // Named with nothing picked, it is taken as it is; a pick named with it must be the machine's.
    expect(decide({ as: "named", claim: data })).toBe("ok");
    expect(decide({ as: "named", claim: data, picks: { environment: "web" } })).toBe("picks");
    // The cap counts who is there and who is on their way, a finished worker like any other.
    const there = [on("x", A), on("y", A)];
    expect(decide({ claim: claim("shared"), on: there, coming: 1, cap: 4 })).toBe("ok");
    expect(decide({ claim: claim("shared"), on: there, coming: 2, cap: 4 })).toBe("full");
    expect(decide({ claim: claim("shared"), on: there, cap: 2 })).toBe("full");
  });

  it("works out the claim of a machine from before claims only from spawns that named it", () => {
    const named = { machine: NAME, packing: "shared", picks: { size: "large" } };
    expect(
      claimFromWorkers(NAME, "m-1", [on("x", A, named), on("y", A, { machine: NAME })], 9),
    ).toEqual({ orchestrator: A, mode: "shared", picks: { size: "large" }, at: 9 });
    // A worker another orchestrator took on carries no placement, and says nothing of the machine.
    expect(
      claimFromWorkers(NAME, "m-1", [on("x", A, named), on("guest", B)], 9)?.orchestrator,
    ).toBe(A);
    expect(claimFromWorkers(NAME, "m-1", [on("guest", B)], 9)).toBeUndefined();
    // Two orchestrators' spawns naming one machine say nothing either: it takes no worker.
    expect(
      claimFromWorkers(NAME, "m-1", [on("x", A, named), on("y", B, named)], 9),
    ).toBeUndefined();
  });
});

describe("a worker machine's claim on record", () => {
  it("survives a restart, is never rewritten, and a file that can't be read opens nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-claims-test-"));
    try {
      const first = fileMachineClaims(dir);
      expect(first.claim(NAME, claim("exclusive"))).toMatchObject({ orchestrator: A });
      // Asked for again by another: the claim on record stands.
      expect(first.claim(NAME, { ...claim("shared"), orchestrator: B })).toMatchObject({
        orchestrator: A,
        mode: "exclusive",
      });
      expect(fileMachineClaims(dir).get(NAME)).toEqual(claim("exclusive"));
      // Pruned only once its machine is gone and it is old; one asked for a moment ago stays.
      first.prune(new Set(), 2, 60_000);
      expect(first.get(NAME)).toBeDefined();
      first.prune(new Set([NAME]), 10 * 60_000, 60_000);
      expect(first.get(NAME)).toBeDefined();
      // A file that says something else is no claim: the machine has none, and with none it
      // takes no worker beside those on it.
      writeFileSync(
        join(dir, "remote-access", "worker-machine-claims.json"),
        JSON.stringify({
          version: 1,
          claims: [{ name: NAME, orchestrator: 7, mode: "any", at: 1 }],
        }),
        { mode: 0o600 },
      );
      expect(fileMachineClaims(dir).get(NAME)).toBeUndefined();
      expect(decide({ as: "named", claim: fileMachineClaims(dir).get(NAME) })).toBe("not_yours");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
