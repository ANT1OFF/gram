import {
  effectiveCheckout,
  HOST_PROTOCOL_VERSION,
  hostOf,
  isLocalHost,
  type HostId,
  type MachineState,
  type SentTo,
  type Thread,
} from "@gram/contracts";

import { agoText } from "@/lib/time";
import { machineHealth } from "@/settings/machine-status";

/**
 * What a thread says of the other machine it runs on, wherever the thread is listed: the machine's
 * name, a word for its state when it can't be reached, and its hover's lines.
 */
export interface MachineMark {
  /** Its name; absent until the machines are known, and for one no longer joined. */
  readonly name?: string;
  /**
   * Why nothing reaches it now, in a word or two; absent while it is online, and before the
   * machines are known.
   */
  readonly state?:
    | "offline"
    | "starting"
    | "restoring"
    | "paused"
    | "reclaimed"
    | "failed"
    | "needs update"
    | "not joined"
    | "asks you"
    | "signed out"
    | "not heard";
  /**
   * The corner mark its glyph wears, beside the glyph's shape: something brings it back (`busy`),
   * it waits to be woken (`waiting`), or it failed. Absent for a machine that is online, or merely
   * offline, which its glyph alone says.
   */
  readonly badge?: "busy" | "waiting" | "failed";
  /** Epoch ms since it has been in its state, where that is known. */
  readonly since?: number;
  /** Set for a worker sent to a server: it runs there, and this app holds none of its files. */
  readonly sent?: true;
  /**
   * The hosted server a worker's machine came through (`MachineState.hosted`): its mark stands in
   * the machine's place, and the machine's own name is on the hover.
   */
  readonly hosted?: { readonly name: string; readonly logo?: string };
  /**
   * Epoch ms since a thread has waited on it to be started (`MachineState.starting`): it stopped,
   * and whoever runs the machines is bringing it back. Set only with `state` "starting".
   */
  readonly startingSince?: number;
  /** Where it runs in a few words, for a row's own hover and accessible name: "on atlas, offline". */
  readonly words: string;
  /** The hover: the machine, how it got in and its state, then why and the fix when offline. */
  readonly hint: string;
}

/** A starting machine's hover, under its state. */
export const STARTING_WHY =
  "It stopped while idle, and is starting again for a thread that waits on it.";

const RESTORING_WHY = "Its threads' folders are being put back. Their sessions open once they are.";
const STALLED_WHY =
  "Putting its threads back made no progress, so no session opens over folders that may not be there. It goes on once the restore does.";
const PAUSED_WHY: Readonly<Record<"idle" | "released", string>> = {
  idle: "It paused with nothing to do, and starts again when work wants it.",
  released: "Its work is over, so its provider lets it go once idle.",
};
const RECLAIMED_WHY =
  "Its provider took its compute away, as with a spot interruption or a node replaced.";
const FAILED_WHY = "Its provider couldn't start it.";

const lasted = (since: number | undefined, now: number) =>
  since === undefined || now - since < 60_000
    ? ""
    : ` for ${agoText(since, now, { long: true }).replace(/ ago$/, "")}`;

const ago = (since: number | undefined, now: number) =>
  since === undefined ? "" : ` ${agoText(since, now, { long: true })}`;

/**
 * Where a machine that isn't simply online or offline stands, from what this Gram and whoever runs
 * the machine said of it: its state's word, its corner mark, since when, the state's line for its
 * hover and why. Undefined for a machine that is online, or offline with nothing more known.
 */
export function machineCondition(
  machine: MachineState,
  now = Date.now(),
):
  | {
      readonly state: "starting" | "restoring" | "paused" | "reclaimed" | "failed";
      readonly badge?: "busy" | "waiting" | "failed";
      readonly since?: number;
      readonly line: string;
      readonly why: string;
    }
  | undefined {
  if (machine.onlineSince !== undefined) {
    if (machine.restoring === undefined) return undefined;
    if (machine.stalled !== undefined)
      return {
        state: "failed",
        badge: "failed",
        since: machine.stalled,
        line: `restore stalled${ago(machine.stalled, now)}`,
        why: STALLED_WHY,
      };
    return {
      state: "restoring",
      badge: "busy",
      since: machine.restoring,
      line: `restoring${lasted(machine.restoring, now)}`,
      why: RESTORING_WHY,
    };
  }
  const said = machine.provider;
  const offlineAt =
    machine.offline !== undefined && "at" in machine.offline ? machine.offline.at : undefined;
  const coming = machine.starting !== undefined || said?.phase === "starting";
  if (said?.phase === "failed" && machine.starting === undefined) {
    const since = said.since ?? said.at;
    return {
      state: "failed",
      badge: "failed",
      since,
      line: `failed${ago(since, now)}`,
      why: said.message ?? FAILED_WHY,
    };
  }
  if (said?.cause === "reclaimed") {
    const since = said.since ?? offlineAt ?? said.at;
    return {
      state: "reclaimed",
      ...(coming ? { badge: "busy" as const } : {}),
      since,
      line: `reclaimed by its provider${ago(since, now)}${coming ? ", restarting" : ""}`,
      why: RECLAIMED_WHY,
    };
  }
  if (coming) {
    const since = machine.starting ?? said?.since ?? said?.at;
    return {
      state: "starting",
      badge: "busy",
      ...(since === undefined ? {} : { since }),
      line: `starting${lasted(since, now)}`,
      why: machine.starting === undefined ? "Its provider is starting it." : STARTING_WHY,
    };
  }
  const pausedFor =
    said?.cause === "released"
      ? "released"
      : machine.paused !== undefined || said?.cause === "idle"
        ? "idle"
        : undefined;
  if (pausedFor !== undefined) {
    const since = machine.paused ?? said?.since ?? said?.at;
    return {
      state: "paused",
      badge: "waiting",
      ...(since === undefined ? {} : { since }),
      line: `${pausedFor === "released" ? "released, pausing when idle" : "paused while idle"}${lasted(since, now)}`,
      why: PAUSED_WHY[pausedFor],
    };
  }
  return undefined;
}

const KIND: Readonly<Record<MachineState["kind"], string>> = {
  joined: "Joined machine",
  provisioned: "Provisioned host",
};

/**
 * The machine a thread's checkout is on, or `undefined` for this one, and for a thread that waits
 * for its machine (`Thread.awaitingMachine`): it is on none yet, and its wait is said in its own
 * words (`awaiting-machine-model.ts`), never as a machine that is no longer joined.
 */
export const threadHost = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "awaitingMachine"> | undefined,
): HostId | undefined => {
  if (thread === undefined || thread.awaitingMachine !== undefined) return undefined;
  const checkout = effectiveCheckout(thread);
  return isLocalHost(checkout) ? undefined : hostOf(checkout);
};

/**
 * The mark of the machine `hostId`, read from the machines the server sent. Its state is said in
 * the words Settings → Machines uses (`machineHealth`), so an offline machine reads the same in a
 * row's hover as on its settings row.
 */
export function machineMark(
  hostId: HostId,
  machines: ReadonlyArray<MachineState> | undefined,
  now = Date.now(),
): MachineMark {
  if (machines === undefined)
    return { words: "on another machine", hint: "Runs on another machine" };
  const machine = machines.find((each) => each.id === hostId);
  if (machine === undefined)
    return {
      state: "not joined",
      words: "on a machine that is no longer joined",
      hint: "Runs on a machine that is no longer joined to this Gram",
    };
  const health = machineHealth(
    { ...machine, confirmed: true },
    { protocol: HOST_PROTOCOL_VERSION },
    now,
  );
  const hosted = machine.hosted;
  const where = hosted === undefined ? machine.name : `${hosted.name}'s machine`;
  const head = `Runs on ${where}`;
  const kind =
    hosted === undefined ? KIND[machine.kind] : `${machine.name} · ${KIND[machine.kind]}`;
  const from = hosted === undefined ? {} : { hosted };
  const condition = health.tone === "update" ? undefined : machineCondition(machine, now);
  if (condition !== undefined)
    return {
      name: machine.name,
      state: condition.state,
      ...from,
      ...(condition.badge === undefined ? {} : { badge: condition.badge }),
      ...(condition.since === undefined ? {} : { since: condition.since }),
      ...(condition.state === "starting" && machine.starting !== undefined
        ? { startingSince: machine.starting }
        : {}),
      words: `on ${where}, ${condition.state}`,
      hint: [head, `${kind} · ${condition.line}`, condition.why].join("\n"),
    };
  if (health.tone === "online")
    return {
      name: machine.name,
      ...from,
      words: `on ${where}`,
      hint: `${head}\n${kind} · ${health.label}`,
    };
  const older = health.tone === "update";
  const newer =
    older &&
    machine.offline?.kind === "mismatch" &&
    machine.offline.protocol > HOST_PROTOCOL_VERSION;
  const state =
    older && !newer ? "needs update" : machine.starting !== undefined ? "starting" : "offline";
  return {
    name: machine.name,
    state,
    ...from,
    ...(state === "starting" && machine.starting !== undefined
      ? { startingSince: machine.starting }
      : {}),
    words: `on ${where}, ${state}`,
    hint: [
      head,
      `${kind} · ${newer ? "newer than this Gram" : state}`,
      state === "starting" ? STARTING_WHY : health.why,
      machine.kind === "provisioned" || state === "starting"
        ? undefined
        : older && !newer
          ? "Update it in Settings → Machines."
          : health.fix,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  };
}

/** The server's host, as a mark names it: `gram.example.com`. */
export const sentHost = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Where a worker sent to a server runs, as a machine's mark says it: the workspace there by name,
 * a word when it waits on its orchestrator there, and "signed out" when this app can't hear from
 * it, with the app's sentence on the hover. Its state there is as last heard.
 */
export function sentMark(sent: SentTo): MachineMark {
  const where = `${sent.workspace} · ${sentHost(sent.origin)}`;
  const state =
    sent.unheard !== undefined
      ? /sign/i.test(sent.unheard)
        ? ("signed out" as const)
        : ("not heard" as const)
      : sent.state === "waiting"
        ? ("asks you" as const)
        : undefined;
  return {
    name: sent.workspace,
    ...(state === undefined ? {} : { state }),
    sent: true,
    words: state === undefined ? `on ${where}` : `on ${where}, ${state}`,
    hint: [
      `Runs on ${where}`,
      `Sent to ${sent.server}, under its rules · ${SENT_WORDS[sent.state]}`,
      sent.unheard,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  };
}

const SENT_WORDS: Readonly<Record<SentTo["state"], string>> = {
  running: "at work there",
  waiting: "waiting on an answer there",
  done: "done there",
  failed: "failed there",
  stopped: "stopped there",
};
