import {
  effectiveCheckout,
  HOST_PROTOCOL_VERSION,
  hostOf,
  isLocalHost,
  type HostId,
  type MachineState,
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
  readonly state?: "offline" | "needs update" | "not joined";
  /** Where it runs in a few words, for a row's own hover and accessible name: "on atlas, offline". */
  readonly words: string;
  /** The hover: the machine, how it got in and its state, then why and the fix when offline. */
  readonly hint: string;
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
  const state = older && !newer ? "needs update" : "offline";
  return {
    name: machine.name,
    state,
    words: `on ${machine.name}, ${state}`,
    hint: [
      head,
      `${KIND[machine.kind]} · ${newer ? "newer than this Gram" : state}`,
      health.why,
      // A provisioned host is replaced by whoever started it; the fixes are a joined machine's.
      machine.kind === "provisioned"
        ? undefined
        : older && !newer
          ? "Update it in Settings → Machines."
          : health.fix,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  };
}
