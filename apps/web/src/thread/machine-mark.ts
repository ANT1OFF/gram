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
    | "needs update"
    | "not joined"
    // A worker sent to a server: it waits on its orchestrator there, or this app can't hear it.
    | "asks you"
    | "signed out"
    | "not heard";
  /** Set for a worker sent to a server: it runs there, and this app holds none of its files. */
  readonly sent?: true;
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
  // The protocol this build speaks is the server's: the page is served with it.
  const health = machineHealth(
    { ...machine, confirmed: true },
    { protocol: HOST_PROTOCOL_VERSION },
    now,
  );
  const head = `Runs on ${machine.name}`;
  if (health.tone === "online")
    return {
      name: machine.name,
      words: `on ${machine.name}`,
      hint: `${head}\n${KIND[machine.kind]} · ${health.label}`,
    };
  // A host this Gram can't talk to: the older of the two needs the update. When that is this Gram,
  // the machine is offline with the reason on its hover, never told to update itself.
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
    ...(state === "starting" && machine.starting !== undefined
      ? { startingSince: machine.starting }
      : {}),
    words: `on ${machine.name}, ${state}`,
    hint: [
      head,
      `${KIND[machine.kind]} · ${newer ? "newer than this Gram" : state}`,
      // Being brought back: why it went and how to bring it back are not the person's to act on.
      state === "starting" ? STARTING_WHY : health.why,
      // A provisioned host is replaced by whoever started it; the fixes are a joined machine's.
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
