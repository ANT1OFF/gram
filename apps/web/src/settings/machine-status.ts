import { agoText, formatStamp } from "@/lib/time";

import type { JoinedMachine, MachineBusy, MachinesStatus } from "./machines-api";

/** How a joined machine is doing, in the words Settings → Machines and the picker share. */
export interface MachineHealth {
  readonly tone: "online" | "offline" | "waiting" | "update";
  /** The state in a word or two: "online for 2 hours", "offline", "Needs update (1.16.0 → 1.17.0)". */
  readonly label: string;
  /** Why, for its hover: what this Gram saw last. */
  readonly why?: string;
  /** What fixes it, where something does. */
  readonly fix?: string;
  /**
   * Set when its release isn't this Gram's, so updating it is worth offering: the release it runs
   * (absent when it didn't say, as hosts of 1.16.0 and earlier don't) and this Gram's.
   */
  readonly update?: { readonly from?: string; readonly to: string };
}

const minutes = (ms: number) => Math.max(1, Math.round(Math.abs(ms) / 60_000));

/** Negative when release `a` is earlier than `b`, as the server orders them. */
const splitRelease = (release: string) => {
  const [core = "", pre] = release.split("-", 2);
  return { numbers: core.split(".").map(Number), pre };
};

export const compareReleases = (a: string, b: string): number => {
  const split = splitRelease;
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
};

/** Whether `machine` runs an earlier release than this Gram's (or one too old to say). */
const behind = (machine: JoinedMachine, mine: string | undefined) =>
  mine !== undefined &&
  (machine.release === undefined || compareReleases(machine.release, mine) < 0);

/**
 * The machine's state, why it is in it, and the fix where there is one. Only a host this Gram
 * can't talk to (another protocol, or short of what this build needs) is "Needs update"; one on
 * another release that speaks the same protocol works, and only its hover says it could update.
 */
export function machineHealth(
  machine: JoinedMachine,
  status: Pick<MachinesStatus, "release" | "protocol">,
  now = Date.now(),
): MachineHealth {
  const name = machine.name;
  const at = (time: number) => formatStamp(time, now);
  const mine = status.release;
  // An earlier release is worth offering an update for; without one here there is none to move to.
  const update =
    mine !== undefined && behind(machine, mine)
      ? { ...(machine.release === undefined ? {} : { from: machine.release }), to: mine }
      : undefined;
  const runs = machine.release === undefined ? "an earlier Gram" : `Gram ${machine.release}`;

  if (!machine.confirmed)
    return {
      tone: "waiting",
      label: "waiting for you to confirm it",
      ...(machine.offline?.kind === "unconfirmed"
        ? { why: `It dialled in at ${at(machine.offline.at)}.` }
        : {}),
      fix: "Confirm it once its fingerprint matches the one it printed.",
    };

  if (machine.onlineSince !== undefined)
    return {
      tone: "online",
      label:
        now - machine.onlineSince < 60_000
          ? "online"
          : `online for ${agoText(machine.onlineSince, now, { long: true }).replace(/ ago$/, "")}`,
      ...(update === undefined
        ? {}
        : {
            why: `Runs ${runs}; this one is ${update.to}. They work together.`,
            fix:
              machine.selfUpdate === true
                ? `Update moves it to ${update.to} once it's idle, with no shell there.`
                : `Rerun the installer on ${name} to match.`,
            update,
          }),
    };

  const offline = machine.offline ?? { kind: "never" as const };
  switch (offline.kind) {
    case "mismatch": {
      const newer = status.protocol !== undefined && offline.protocol > status.protocol;
      const from = offline.release ?? machine.release;
      return {
        tone: "update",
        label: newer
          ? `Newer than this Gram${from === undefined ? "" : ` (${from})`}`
          : `Needs update (${from ?? "earlier"} → ${mine ?? "this Gram's"})`,
        why: `${name} runs ${from === undefined ? runs : `Gram ${from}`}, which this Gram can't talk to.`,
        fix: newer
          ? `Update Gram here, or rerun the installer on ${name} to match this one.`
          : `Update reruns the installer on ${name}.`,
        ...(mine === undefined
          ? {}
          : { update: { ...(from === undefined ? {} : { from }), to: mine } }),
      };
    }
    case "clock":
      return {
        tone: "offline",
        label: "offline",
        why: `Clock is ${minutes(offline.skewMs)} min ${offline.skewMs > 0 ? "ahead" : "behind"}.`,
        fix: `Fix the time on ${name}.`,
      };
    case "bad-signature":
      return {
        tone: "offline",
        label: "offline",
        why: `A dial at ${at(offline.at)} wasn't signed by its key.`,
        fix: `Remove ${name}, run gram-host leave there, and add it again.`,
      };
    case "no-hello":
      return {
        tone: "offline",
        label: "offline",
        why: `It dialled in at ${at(offline.at)} but didn't answer.`,
        fix: `Rerun the installer on ${name}.`,
      };
    case "lost":
      return {
        tone: "offline",
        label: "offline",
        why: `Connection lost at ${at(offline.at)}.`,
        fix: `It dials again by itself. If it stays offline, check Tailscale and gram-host status on ${name}.`,
      };
    case "moved":
      return {
        tone: "offline",
        label: "offline",
        why: `This Gram's tailnet address changed at ${at(offline.at)}.`,
        fix: `Run gram-host leave on ${name}, then add it again.`,
      };
    case "tailscale-off":
      return {
        tone: "offline",
        label: "offline",
        why: "Access over Tailscale is off, so no machine can dial in.",
        fix: "Turn it on in Phone access.",
      };
    case "unconfirmed":
      // Refused before it was confirmed; it dials again within half a minute.
      return {
        tone: "offline",
        label: "offline",
        why: "Confirmed. Waiting for it to dial in again.",
      };
    case "never":
      return {
        tone: "offline",
        label: "offline",
        why: "It hasn't dialled in since Gram started.",
        fix: `Check gram-host status on ${name}.`,
      };
  }
}

/** The hover's words: why, then the fix, one line each. */
export const healthHint = (health: MachineHealth): string | undefined => {
  const lines = [health.why, health.fix].filter((line) => line !== undefined);
  return lines.length === 0 ? undefined : lines.join("\n");
};

const MB = 1024 * 1024;

/** "1 running turn and 2 busy terminals". */
export const busyText = (busy: MachineBusy): string => {
  const named = (
    [
      [busy.turns, "running turn"],
      [busy.terminals, "busy terminal"],
      [busy.clones, "clone"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, what]) => `${count} ${what}${count === 1 ? "" : "s"}`);
  return named.length <= 1
    ? (named[0] ?? "work")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
};

/** How long a finished update still shows on its row. */
const UPDATED_SHOWN_MS = 10 * 60_000;

/**
 * The machine's update in a line for its row, with its tone: under way, waiting for it to be idle,
 * or how it ended. `undefined` when there is none to show.
 */
export function machineUpdateLine(
  machine: JoinedMachine,
  now = Date.now(),
): { readonly text: string; readonly tone: "progress" | "done" | "failed" } | undefined {
  const update = machine.update;
  if (update === undefined) return undefined;
  const to = update.release;
  switch (update.phase) {
    case "waiting":
      return {
        tone: "progress",
        text: `Updates to ${to} once ${machine.name} is idle: ${busyText(update.busy)}.`,
      };
    case "downloading":
      return {
        tone: "progress",
        text:
          update.total !== undefined && update.total > 0
            ? `Updating to ${to}: downloading, ${Math.min(100, Math.floor((update.received / update.total) * 100))}%`
            : `Updating to ${to}: downloading${update.received > 0 ? `, ${Math.round(update.received / MB)} MB` : ""}`,
      };
    case "verifying":
      return { tone: "progress", text: `Updating to ${to}: checking the download` };
    case "unpacking":
      return { tone: "progress", text: `Updating to ${to}: unpacking` };
    case "testing":
      return { tone: "progress", text: `Updating to ${to}: testing the new app` };
    case "switching":
    case "restarting":
      return {
        tone: "progress",
        text: `Updating to ${to}: restarting. It dials in again in a moment.`,
      };
    case "updated":
      return now - update.at < UPDATED_SHOWN_MS
        ? { tone: "done", text: `Updated to ${to} at ${formatStamp(update.at, now)}.` }
        : undefined;
    case "rolledBack":
      return {
        tone: "failed",
        text: `Update to ${to} didn't start, so ${machine.name} went back${machine.release === undefined ? "" : ` to ${machine.release}`}. ${update.message}`,
      };
    case "failed":
      return { tone: "failed", text: `Update to ${to} failed: ${update.message}` };
  }
}

/** Whether an update is under way, so its row's Update waits. */
export const updating = (machine: JoinedMachine): boolean =>
  machine.update !== undefined &&
  machine.update.phase !== "updated" &&
  machine.update.phase !== "failed" &&
  machine.update.phase !== "rolledBack" &&
  machine.update.phase !== "waiting";
