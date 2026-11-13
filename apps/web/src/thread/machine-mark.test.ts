import { HOST_PROTOCOL_VERSION, HostId, type MachineState } from "@gram/contracts";
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
