import { AWAITED_HOST_ID, HOST_PROTOCOL_VERSION, HostId, type MachineState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { machineMark, threadHost } from "./machine-mark";

const NOW = Date.parse("2026-06-15T10:00:00Z");
const AT = NOW - 7 * 60_000;
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(AT);

const ATLAS = HostId.make("m-0123456789abcdef01234567");
const STUDIO = HostId.make("m-89abcdef0123456701234567");
const SANDBOX = HostId.make("m-456789abcdef012301234567");

const machines: ReadonlyArray<MachineState> = [
  { id: ATLAS, name: "atlas", kind: "joined", onlineSince: NOW - 2 * 3_600_000 },
  { id: STUDIO, name: "studio", kind: "joined", offline: { kind: "lost", at: AT } },
  { id: SANDBOX, name: "sandbox-1", kind: "provisioned", onlineSince: NOW - 12 * 60_000 },
];

describe("the machine a thread runs on", () => {
  it("is none for a checkout on this machine, and the effective checkout's otherwise", () => {
    expect(threadHost(undefined)).toBeUndefined();
    expect(
      threadHost({ checkout: { kind: "worktree", path: "/work/a" } } as never),
    ).toBeUndefined();
    expect(
      threadHost({ checkout: { kind: "worktree", path: "/work/a", hostId: ATLAS } } as never),
    ).toBe(ATLAS);
    // A thread moved to another checkout runs where that one is.
    expect(
      threadHost({
        checkout: { kind: "worktree", path: "/work/a", hostId: ATLAS },
        currentCheckout: { kind: "worktree", path: "/work/b", hostId: STUDIO },
      } as never),
    ).toBe(STUDIO);
  });

  it("is none for a thread that waits for its machine, which is on none yet", () => {
    expect(
      threadHost({
        checkout: { kind: "main", path: "/.threads/t1", hostId: AWAITED_HOST_ID },
        awaitingMachine: { since: 1 },
      } as never),
    ).toBeUndefined();
  });
});

describe("a machine's mark", () => {
  it("names an online machine, with how it got in and how long it has been online", () => {
    expect(machineMark(ATLAS, machines, NOW)).toEqual({
      name: "atlas",
      words: "on atlas",
      hint: "Runs on atlas\nJoined machine · online for 2 hours",
    });
    expect(machineMark(SANDBOX, machines, NOW).hint).toBe(
      "Runs on sandbox-1\nProvisioned host · online for 12 minutes",
    );
  });

  it("names a hosted server's worker machine by the server, its own name second", () => {
    const WORKER = HostId.make("m-fedcba987654321001234567");
    const hosted = { name: "Example Cloud" };
    const online: MachineState = {
      id: WORKER,
      name: "worker-827d7eaf1e",
      kind: "provisioned",
      onlineSince: NOW - 12 * 60_000,
      hosted,
    };
    expect(machineMark(WORKER, [online], NOW)).toEqual({
      name: "worker-827d7eaf1e",
      hosted,
      words: "on Example Cloud's machine",
      hint: "Runs on Example Cloud's machine\nworker-827d7eaf1e · Provisioned host · online for 12 minutes",
    });
    const { onlineSince: _, ...gone } = online;
    const offline = machineMark(WORKER, [{ ...gone, offline: { kind: "lost", at: AT } }], NOW);
    expect(offline.words).toBe("on Example Cloud's machine, offline");
    expect(offline.hint.split("\n").slice(0, 2)).toEqual([
      "Runs on Example Cloud's machine",
      "worker-827d7eaf1e · Provisioned host · offline",
    ]);
  });

  it("says a machine is offline, why, and the fix, as Settings → Machines does", () => {
    expect(machineMark(STUDIO, machines, NOW)).toEqual({
      name: "studio",
      state: "offline",
      words: "on studio, offline",
      hint: [
        "Runs on studio",
        "Joined machine · offline",
        `Connection lost at ${TIME}.`,
        "It dials again by itself. If it stays offline, check Tailscale and gram-host status on studio.",
      ].join("\n"),
    });
  });

  it("says a host on an earlier protocol needs an update, and where to update it", () => {
    const mark = machineMark(
      STUDIO,
      [
        {
          id: STUDIO,
          name: "studio",
          kind: "joined",
          offline: { kind: "mismatch", at: AT, protocol: 1, release: "1.13.0" },
        },
      ],
      NOW,
    );
    expect(mark.state).toBe("needs update");
    expect(mark.words).toBe("on studio, needs update");
    expect(mark.hint.split("\n")).toEqual([
      "Runs on studio",
      "Joined machine · needs update",
      "studio runs Gram 1.13.0, which this Gram can't talk to.",
      "Update it in Settings → Machines.",
    ]);
  });

  it("never tells a host on a later protocol to update: this Gram is the one behind", () => {
    const mark = machineMark(
      STUDIO,
      [
        {
          id: STUDIO,
          name: "studio",
          kind: "joined",
          offline: {
            kind: "mismatch",
            at: AT,
            protocol: HOST_PROTOCOL_VERSION + 1,
            release: "9.0.0",
          },
        },
      ],
      NOW,
    );
    expect(mark.state).toBe("offline");
    expect(mark.hint.split("\n")).toEqual([
      "Runs on studio",
      "Joined machine · newer than this Gram",
      "studio runs Gram 9.0.0, which this Gram can't talk to.",
      "Update Gram here, or rerun the installer on studio to match this one.",
    ]);
  });

  it("leaves a joined machine's fixes off a provisioned host, which is replaced, not repaired", () => {
    const mark = machineMark(
      SANDBOX,
      [{ id: SANDBOX, name: "sandbox-1", kind: "provisioned", offline: { kind: "lost", at: AT } }],
      NOW,
    );
    expect(mark.hint).toBe(
      `Runs on sandbox-1\nProvisioned host · offline\nConnection lost at ${TIME}.`,
    );
  });

  it("names no machine before the server has sent them, and none that left", () => {
    expect(machineMark(ATLAS, undefined, NOW)).toEqual({
      words: "on another machine",
      hint: "Runs on another machine",
    });
    expect(machineMark(ATLAS, [], NOW)).toEqual({
      state: "not joined",
      words: "on a machine that is no longer joined",
      hint: "Runs on a machine that is no longer joined to this Gram",
    });
  });
});

describe("a machine being started again", () => {
  it("reads as starting, with since when, and no fix for the person", () => {
    const mark = machineMark(
      STUDIO,
      [
        {
          id: STUDIO,
          name: "studio",
          kind: "provisioned",
          offline: { kind: "lost", at: AT },
          starting: AT + 1,
        },
      ],
      NOW,
    );
    expect(mark).toMatchObject({
      state: "starting",
      startingSince: AT + 1,
      words: "on studio, starting",
    });
    expect(mark.hint).toContain("starting again for a thread that waits on it");
  });

  it("reads as offline once nothing waits on it", () => {
    expect(machineMark(STUDIO, machines, NOW)).not.toHaveProperty("startingSince");
  });
});

describe("what a machine's mark says of where it stands", () => {
  const WORKER = HostId.make("m-fedcba987654321001234567");
  const base: MachineState = { id: WORKER, name: "worker-827d7eaf1e", kind: "provisioned" };
  const away: MachineState = { ...base, offline: { kind: "lost", at: AT } };
  const mark = (machine: MachineState) => machineMark(WORKER, [machine], NOW);
  const shown = (machine: MachineState) => {
    const { state, badge, since } = mark(machine);
    return { state, badge, since };
  };

  it("is online, with no badge, while it is connected and owes nothing", () => {
    expect(shown({ ...base, onlineSince: AT })).toEqual({
      state: undefined,
      badge: undefined,
      since: undefined,
    });
  });

  it("is restoring while its threads are put back, and failed once that stalls", () => {
    const back = { ...base, onlineSince: AT, restoring: AT };
    expect(shown(back)).toEqual({ state: "restoring", badge: "busy", since: AT });
    expect(shown({ ...back, stalled: NOW - 60_000 })).toEqual({
      state: "failed",
      badge: "failed",
      since: NOW - 60_000,
    });
  });

  it("is starting while something waits on it, or its provider says it starts", () => {
    expect(shown({ ...away, starting: AT })).toEqual({
      state: "starting",
      badge: "busy",
      since: AT,
    });
    expect(shown({ ...away, provider: { phase: "starting", since: AT, at: AT } })).toEqual({
      state: "starting",
      badge: "busy",
      since: AT,
    });
  });

  it("is paused once readied to stop and gone, or when its provider says idle or released", () => {
    expect(shown({ ...away, paused: AT })).toEqual({
      state: "paused",
      badge: "waiting",
      since: AT,
    });
    for (const cause of ["idle", "released"] as const)
      expect(shown({ ...away, provider: { phase: "stopped", cause, since: AT, at: NOW } })).toEqual(
        {
          state: "paused",
          badge: "waiting",
          since: AT,
        },
      );
  });

  it("is reclaimed when its provider took it away, busy only while it comes back", () => {
    const reclaimed = {
      ...away,
      paused: AT,
      provider: { phase: "stopped", cause: "reclaimed", since: AT, at: NOW },
    } as const;
    expect(shown(reclaimed)).toEqual({ state: "reclaimed", badge: undefined, since: AT });
    expect(shown({ ...reclaimed, starting: NOW - 60_000 })).toEqual({
      state: "reclaimed",
      badge: "busy",
      since: AT,
    });
    expect(mark({ ...reclaimed, starting: NOW - 60_000 }).hint.split("\n")[1]).toContain(
      "7 minutes ago, restarting",
    );
  });

  it("is failed, with the provider's reason, when its provider says it failed", () => {
    const failed = mark({
      ...away,
      provider: { phase: "failed", message: "No capacity in the zone.", since: AT, at: NOW },
    });
    expect(failed).toMatchObject({ state: "failed", badge: "failed", since: AT });
    expect(failed.hint.split("\n")[2]).toBe("No capacity in the zone.");
  });

  it("stays offline, with no badge, when nothing more is known", () => {
    expect(shown(away)).toEqual({ state: "offline", badge: undefined, since: undefined });
    expect(shown({ ...away, provider: { phase: "running", at: NOW } }).state).toBe("offline");
  });
});
