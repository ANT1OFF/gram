import { agoText, formatStamp } from "@/lib/time";

import type { JoinedMachine, MachinesStatus } from "./machines-api";

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
  // A release apart is worth offering an update for; without one here there is none to move to.
  const update =
    mine !== undefined && machine.release !== mine
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
            fix: `Rerun the installer on ${name} to match.`,
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
