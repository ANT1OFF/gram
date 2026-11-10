import { describe, expect, it } from "vitest";

import { compareReleases, healthHint, machineHealth } from "./machine-status";
import type { JoinedMachine, OfflineReason } from "./machines-api";

const NOW = Date.parse("2026-06-15T10:00:00Z");
const AT = NOW - 7 * 60_000;
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(AT);
const STATUS = { release: "1.15.2", protocol: 2 };

const machine = (overrides: Partial<JoinedMachine> = {}): JoinedMachine => ({
  id: "m-0123456789abcdef01234567",
  name: "cachyos",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: NOW - 86_400_000,
  confirmed: true,
  ...overrides,
});

const offline = (reason: OfflineReason, overrides: Partial<JoinedMachine> = {}) =>
  machineHealth(machine({ offline: reason, ...overrides }), STATUS, NOW);

describe("a joined machine's health", () => {
  it("says why it is offline, and the fix, for each reason", () => {
    expect(healthHint(offline({ kind: "clock", at: AT, skewMs: 3 * 60_000 + 4_000 }))).toBe(
      "Clock is 3 min ahead.\nFix the time on cachyos.",
    );
    expect(offline({ kind: "clock", at: AT, skewMs: -5 * 60_000 }).why).toBe(
      "Clock is 5 min behind.",
    );
    expect(healthHint(offline({ kind: "bad-signature", at: AT }))).toBe(
      `A dial at ${TIME} wasn't signed by its key.\nRemove cachyos, run gram-host leave there, and add it again.`,
    );
    expect(healthHint(offline({ kind: "no-hello", at: AT }))).toBe(
      `It dialled in at ${TIME} but didn't answer.\nRerun the installer on cachyos.`,
    );
    expect(offline({ kind: "lost", at: AT }).why).toBe(`Connection lost at ${TIME}.`);
    expect(offline({ kind: "moved", at: AT }).fix).toBe(
      "Run gram-host leave on cachyos, then add it again.",
    );
    expect(healthHint(offline({ kind: "tailscale-off" }))).toBe(
      "Access over Tailscale is off, so no machine can dial in.\nTurn it on in Phone access.",
    );
    // Switched on, but down on this computer: what's wrong here, and that it comes back by itself.
    const here = "this (Mac|computer)";
    const down = [
      [
        "stopped",
        `^Tailscale is stopped on ${here}\\.\nTurn it on, and Gram will reconnect machines by itself\\.$`,
      ],
      [
        "signed-out",
        `^Tailscale is signed out on ${here}\\.\nSign in, and Gram will reconnect machines by itself\\.$`,
      ],
      [
        "missing",
        `^Gram can't find Tailscale on ${here}\\.\nInstall it, and Gram will reconnect machines by itself\\.$`,
      ],
      [
        "no-https",
        "^HTTPS certificates are off for your tailnet\\.\nTurn them on in the Tailscale admin console\\.$",
      ],
      ["error", `^Tailscale didn't answer on ${here}\\.\nGram tries again by itself\\.$`],
      ["serve", "^Gram couldn't set up Tailscale Serve\\.\nPhone access says why\\.$"],
    ] as const;
    for (const [cause, hint] of down) {
      const health = offline({ kind: "tailscale-down", cause });
      expect(health).toMatchObject({ tone: "offline", label: "offline" });
      expect(healthHint(health)).toMatch(new RegExp(hint));
      // Never the switch's advice: it is on.
      expect(healthHint(health)).not.toContain("Turn it on in Phone access");
    }
    expect(healthHint(offline({ kind: "never" }))).toBe(
      "It hasn't dialled in since Gram started.\nCheck gram-host status on cachyos.",
    );
    expect(offline({ kind: "unconfirmed", at: AT })).toMatchObject({ label: "offline" });
    // Each is plainly offline: only a real mismatch reads otherwise.
    for (const kind of ["lost", "no-hello", "moved", "bad-signature"] as const)
      expect(offline({ kind, at: AT })).toMatchObject({ tone: "offline", label: "offline" });
  });

  it("says a machine still to confirm waits for you, with when it dialled", () => {
    expect(
      machineHealth(
        machine({ confirmed: false, offline: { kind: "unconfirmed", at: AT } }),
        STATUS,
        NOW,
      ),
    ).toMatchObject({
      tone: "waiting",
      label: "waiting for you to confirm it",
      why: `It dialled in at ${TIME}.`,
    });
  });

  it("calls only a host it can't talk to a mismatch, with the releases on each side", () => {
    expect(
      offline({ kind: "mismatch", at: AT, protocol: 1, release: "1.15.0" }, { release: "1.15.0" }),
    ).toMatchObject({
      tone: "update",
      label: "Needs update (1.15.0 → 1.15.2)",
      fix: "Update reruns the installer on cachyos.",
      update: { from: "1.15.0", to: "1.15.2" },
    });
    // A host from before releases were sent, short of what this build needs.
    expect(offline({ kind: "mismatch", at: AT, protocol: 2, missing: ["sessions"] })).toMatchObject(
      { label: "Needs update (earlier → 1.15.2)", update: { to: "1.15.2" } },
    );
    // A host newer than this Gram: this one is behind.
    expect(
      offline({ kind: "mismatch", at: AT, protocol: 3, release: "1.17.0" }, { release: "1.17.0" }),
    ).toMatchObject({ tone: "update", label: "Newer than this Gram (1.17.0)" });

    // Another release on the same protocol works: online, with an update offered on hover only.
    const older = machineHealth(
      machine({ onlineSince: NOW - 10_000, release: "1.15.0" }),
      STATUS,
      NOW,
    );
    expect(older).toMatchObject({
      tone: "online",
      label: "online",
      why: "Runs Gram 1.15.0; this one is 1.15.2. They work together.",
      fix: "Rerun the installer on cachyos to match.",
      update: { from: "1.15.0", to: "1.15.2" },
    });
    const same = machineHealth(
      machine({ onlineSince: NOW - 10_000, release: "1.15.2" }),
      STATUS,
      NOW,
    );
    expect(same).not.toHaveProperty("update");
    expect(healthHint(same)).toBeUndefined();
    // Run from source here, there is no release to move to.
    expect(
      machineHealth(machine({ onlineSince: NOW - 10_000, release: "1.15.0" }), {}, NOW),
    ).not.toHaveProperty("update");
  });
});

// Failed on c0a36524 in the independent review: rc.2 sorted after rc.10, so a main on rc.2 read an
// rc.10 machine as behind and offered to move it back.
describe("release order", () => {
  it("orders prereleases as semver, numeric identifiers by value", () => {
    expect(compareReleases("1.17.0-rc.2", "1.17.0-rc.10")).toBeLessThan(0);
    expect(compareReleases("1.17.0-rc.10", "1.17.0")).toBeLessThan(0);
    expect(compareReleases("1.16.0", "1.17.0-rc.1")).toBeLessThan(0);
  });

  it("offers no update to a machine on a later prerelease", () => {
    const ahead: JoinedMachine = {
      id: "m",
      name: "cachyos",
      platform: "linux",
      fingerprint: "0000-0000-0000-0000-0000",
      joinedAt: NOW - 86_400_000,
      confirmed: true,
      onlineSince: NOW - 3_600_000,
      release: "1.17.0-rc.10",
    };
    expect(
      machineHealth(ahead, { release: "1.17.0-rc.2", protocol: 2 }, NOW).update,
    ).toBeUndefined();
  });
});
