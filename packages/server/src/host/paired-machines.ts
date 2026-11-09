import type { KeyObject } from "node:crypto";
import type { HostId, HostStatus } from "@gram/contracts";
import { makeLaunchToken, tokensEqual } from "../http/auth.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import {
  CONNECT_SKEW_MS,
  connectClaimOf,
  fingerprintOf,
  HOST_JOIN_PATH,
  hostIdOf,
  publicKeyFrom,
  verifyConnect,
} from "./machine-keys.ts";
import { SSH_TARGET } from "./ssh-join.ts";

/** How long a join link lasts, as a phone's pairing link does. */
export const JOIN_LIFETIME_MS = 15 * 60_000;
/** How many machines can be joined at once. */
export const MAX_MACHINES = 16;
/** How many dials' nonces can be in their window at once; past it, dials wait. */
const NONCES_KEPT = 4096;

/** A joined machine as the main Gram keeps it: its pinned key and what it said it was. */
export interface PairedMachine {
  readonly id: HostId;
  /** The name it joined with: its host name, or what the person gave `gram-host join --name`. */
  readonly name: string;
  readonly platform: string;
  /** The raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  readonly joinedAt: number;
  /** Set when a person on this machine confirmed its fingerprint; until then it gets no work. */
  readonly confirmedAt?: number;
  /**
   * The `[user@]host` Gram last installed it at over SSH (Add over SSH, or its update), so an
   * update can run that install again; absent for a machine that joined by the command.
   */
  readonly sshTarget?: string;
}

/**
 * The last reason a joined machine dropped or was refused, as this Gram saw it since it started:
 * kept in memory only, and never anything from the dial itself (its signature, nonce or key).
 */
export type MachineProblem =
  /** It dialled, signed by its key, before a person here confirmed it. */
  | { readonly kind: "unconfirmed"; readonly at: number }
  /**
   * A dial named it but its key didn't sign it, or signed it for another address. Anyone on the
   * tailnet who knows its id can send one, so this is only ever shown, never acted on.
   */
  | { readonly kind: "bad-signature"; readonly at: number }
  /**
   * A dial it signed carried a time this far from this machine's clock: positive when ahead. An
   * old dial of its own replayed later reads the same, and is as harmless: only ever shown.
   */
  | { readonly kind: "clock"; readonly at: number; readonly skewMs: number }
  /**
   * It said hello in another protocol version, or without something this build needs: one of the
   * two builds needs an update. Its release, when it sent one.
   */
  | {
      readonly kind: "mismatch";
      readonly at: number;
      readonly protocol: number;
      readonly release?: string;
      readonly missing?: ReadonlyArray<string>;
    }
  /** It dialled in but didn't say hello, in time or as itself. */
  | { readonly kind: "no-hello"; readonly at: number }
  /** Its connection closed. */
  | { readonly kind: "lost"; readonly at: number }
  /** Access over Tailscale moved to another address, which it doesn't dial. */
  | { readonly kind: "moved"; readonly at: number };

export interface PairedMachineStore {
  readonly read: () => PairedMachine[];
  readonly write: (machines: ReadonlyArray<PairedMachine>) => void;
}

/** What a machine sends to join. */
export interface JoinRequest {
  readonly code: string;
  readonly name: string;
  readonly platform: string;
  readonly publicKey: string;
}

export type JoinResult =
  | { readonly kind: "joined"; readonly machine: PairedMachine }
  | { readonly kind: "refused"; readonly status: 400 | 403 | 409; readonly message: string };

export type ConnectResult =
  | { readonly kind: "ok"; readonly machine: PairedMachine }
  | { readonly kind: "refused"; readonly status: 401 | 403; readonly message: string };

const NAME = /^[\p{L}\p{N} ._'-]{1,64}$/u;
const PLATFORM = /^[a-z0-9]{1,16}$/;

const isMachine = (value: unknown): value is PairedMachine => {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m["publicKey"] === "string" &&
    publicKeyFrom(m["publicKey"]) !== undefined &&
    m["id"] === hostIdOf(m["publicKey"]) &&
    typeof m["name"] === "string" &&
    NAME.test(m["name"]) &&
    typeof m["platform"] === "string" &&
    PLATFORM.test(m["platform"]) &&
    Number.isSafeInteger(m["joinedAt"]) &&
    (m["confirmedAt"] === undefined || Number.isSafeInteger(m["confirmedAt"])) &&
    (m["sshTarget"] === undefined ||
      (typeof m["sshTarget"] === "string" && SSH_TARGET.test(m["sshTarget"])))
  );
};

/**
 * The joined machines in `<dataDir>/remote-access/machines.json`: private to this user, refused
 * when it isn't, replaced atomically. Only public keys are kept; there is no secret in it.
 */
export const fileMachineStore = (dataDir: string): PairedMachineStore => {
  const file = privateJsonFile(dataDir, "machines.json", 64 * 1024);
  const read = (): PairedMachine[] => {
    const value = file.read();
    if (value === undefined) return [];
    const record = value as Record<string, unknown> | null;
    if (
      typeof record !== "object" ||
      record === null ||
      record["version"] !== 1 ||
      !Array.isArray(record["machines"]) ||
      record["machines"].length > MAX_MACHINES ||
      !record["machines"].every(isMachine)
    )
      throw new Error("Joined machines storage is invalid");
    return record["machines"] as PairedMachine[];
  };
  return {
    read,
    write: (machines) => {
      // Never repair an unsafe or corrupt file silently.
      read();
      file.write({ version: 1, machines });
    },
  };
};

export const memoryMachineStore = (initial: ReadonlyArray<PairedMachine> = []) => {
  let machines = [...initial];
  return {
    read: () => [...machines],
    write: (next: ReadonlyArray<PairedMachine>) => {
      machines = [...next];
    },
  } satisfies PairedMachineStore;
};

/**
 * The machines joined to this Gram: one join link at a time, single use and short lived as a
 * phone's pairing link is, and each machine's key pinned when it joins. A machine dials in only
 * with a fresh dial signed by that key, and only once a person here confirmed its fingerprint.
 */
export const createPairedMachines = (store: PairedMachineStore, now: () => number = Date.now) => {
  let machines = store.read();
  let invitation: { code: string; origin: string; expiresAt: number } | undefined;
  /** Recent dials' nonces with when they stop mattering. */
  const nonces = new Map<string, number>();
  /** Each machine's last problem since this Gram started. */
  const problems = new Map<string, MachineProblem>();
  const note = (id: string, problem: MachineProblem | undefined) => {
    if (problem === undefined) problems.delete(id);
    else if (byId(id) !== undefined) problems.set(id, problem);
  };
  const save = (next: PairedMachine[]) => {
    store.write(next);
    machines = next;
  };
  /** Memory first, so a removal holds even when saving it throws (until a restart re-reads it). */
  const forget = (next: PairedMachine[]) => {
    machines = next;
    store.write(next);
  };
  const byId = (id: string) => machines.find((machine) => machine.id === id);
  const keys = new Map<string, KeyObject>();
  const keyOf = (machine: PairedMachine) => {
    let key = keys.get(machine.publicKey);
    if (key === undefined) {
      key = publicKeyFrom(machine.publicKey);
      if (key === undefined) return undefined;
      keys.set(machine.publicKey, key);
    }
    return key;
  };
  /**
   * Records a dial's nonce: `replayed` when it was seen before, `full` when the set is full of
   * nonces still in their window, which refuses the dial rather than forget one that could then
   * be replayed.
   */
  const record = (nonce: string, until: number): "ok" | "replayed" | "full" => {
    const at = now();
    for (const [kept, expires] of nonces) if (expires <= at) nonces.delete(kept);
    if (nonces.has(nonce)) return "replayed";
    if (nonces.size >= NONCES_KEPT) return "full";
    nonces.set(nonce, until);
    return "ok";
  };
  return {
    list: (): ReadonlyArray<PairedMachine> => machines,
    get: (id: string): PairedMachine | undefined => byId(id),
    /** A new join link for `origin`, replacing any earlier one. */
    mint: (origin: string) => {
      const code = makeLaunchToken();
      invitation = { code, origin, expiresAt: now() + JOIN_LIFETIME_MS };
      return { url: `${origin}${HOST_JOIN_PATH}#code=${code}`, expiresAt: invitation.expiresAt };
    },
    /** Whether a join link is waiting, for the settings page. */
    joinOpen: (): { readonly expiresAt: number } | undefined =>
      invitation !== undefined && now() < invitation.expiresAt
        ? { expiresAt: invitation.expiresAt }
        : undefined,
    /** Consumes the link before the machine is kept; a wrong code doesn't consume it. */
    join: (origin: string, request: JoinRequest): JoinResult => {
      if (
        invitation === undefined ||
        invitation.origin !== origin ||
        now() >= invitation.expiresAt ||
        !tokensEqual(request.code, invitation.code)
      )
        return { kind: "refused", status: 403, message: "That join link isn't valid any more." };
      if (!NAME.test(request.name) || !PLATFORM.test(request.platform))
        return { kind: "refused", status: 400, message: "The machine's name isn't valid." };
      if (["local", "this machine"].includes(request.name.trim().toLowerCase()))
        return {
          kind: "refused",
          status: 400,
          message:
            "That machine name is reserved for this machine. Choose another name with gram-host join --name.",
        };
      if (publicKeyFrom(request.publicKey) === undefined)
        return { kind: "refused", status: 400, message: "The machine's key isn't valid." };
      const id = hostIdOf(request.publicKey);
      if (byId(id) !== undefined)
        return { kind: "refused", status: 409, message: "This machine has already joined." };
      if (machines.length >= MAX_MACHINES)
        return {
          kind: "refused",
          status: 409,
          message: `Gram can have ${MAX_MACHINES} machines; remove one first.`,
        };
      invitation = undefined;
      const machine: PairedMachine = {
        id,
        name: request.name,
        platform: request.platform,
        publicKey: request.publicKey,
        joinedAt: now(),
      };
      save([...machines, machine]);
      return { kind: "joined", machine };
    },
    confirm: (id: string): PairedMachine | undefined => {
      const machine = byId(id);
      if (machine === undefined) return undefined;
      if (machine.confirmedAt !== undefined) return machine;
      const confirmed = { ...machine, confirmedAt: now() };
      save(machines.map((m) => (m === machine ? confirmed : m)));
      return confirmed;
    },
    /** Records that Gram installed the machine at `target` over SSH, for its updates. */
    installedOverSsh: (id: string, target: string): void => {
      const machine = byId(id);
      if (machine === undefined || !SSH_TARGET.test(target) || machine.sshTarget === target) return;
      save(machines.map((m) => (m === machine ? { ...machine, sshTarget: target } : m)));
    },
    /** Forgets the machine and its key; the caller closes its connection. */
    remove: (id: string): boolean => {
      if (byId(id) === undefined) return false;
      problems.delete(id);
      forget(machines.filter((machine) => machine.id !== id));
      return true;
    },
    /** The machine's last problem since this Gram started, if any. */
    problemOf: (id: string): MachineProblem | undefined => problems.get(id),
    /** Records the machine's latest problem, or (`undefined`) that it came online. */
    note,
    /**
     * Checks a dial's headers: a machine that joined and was confirmed, a time within the skew, a
     * nonce not seen before, and the machine's own signature over all of it and `origin`.
     */
    authorizeConnect: (
      origin: string,
      headers: Readonly<Record<string, string | undefined>>,
    ): ConnectResult => {
      const claim = connectClaimOf(origin, headers);
      if (claim === undefined)
        return { kind: "refused", status: 401, message: "unauthorized: signed dial required" };
      const machine = byId(claim.hostId);
      const key = machine === undefined ? undefined : keyOf(machine);
      if (machine === undefined || key === undefined)
        return { kind: "refused", status: 401, message: "unauthorized: machine not joined" };
      const at = now();
      if (Math.abs(at - claim.time) > CONNECT_SKEW_MS) {
        // Its clock, only when the machine's own key signed the time it is off by.
        if (verifyConnect(key, claim, claim.signature))
          note(machine.id, { kind: "clock", at, skewMs: claim.time - at });
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      }
      if (!verifyConnect(key, claim, claim.signature)) {
        // Anyone can send one, so it never replaces a reason the machine's own key stood behind.
        const kept = problems.get(machine.id)?.kind;
        if (kept === undefined || kept === "bad-signature")
          note(machine.id, { kind: "bad-signature", at });
        return { kind: "refused", status: 401, message: "unauthorized: bad signature" };
      }
      // Checked after the signature, so a forged dial can't spend a real one's nonce.
      const nonce = record(claim.nonce, claim.time + CONNECT_SKEW_MS);
      if (nonce === "replayed")
        return { kind: "refused", status: 401, message: "unauthorized: dial replayed" };
      if (nonce === "full")
        return { kind: "refused", status: 401, message: "unauthorized: too many dials; wait" };
      if (machine.confirmedAt === undefined) {
        note(machine.id, { kind: "unconfirmed", at });
        return { kind: "refused", status: 403, message: "forbidden: confirm this machine first" };
      }
      return { kind: "ok", machine };
    },
  };
};

export type PairedMachines = ReturnType<typeof createPairedMachines>;

/**
 * Why a machine is offline, as the settings page says it: its last problem, or that access over
 * Tailscale is off (which no machine can dial), or that it hasn't dialled since this Gram started.
 */
export type OfflineReason =
  | MachineProblem
  | { readonly kind: "tailscale-off" }
  | { readonly kind: "never" };

/** A machine as the settings page lists it: no key, its fingerprint instead. */
export const machineView = (
  machine: PairedMachine,
  online:
    | {
        readonly since: number;
        readonly status?: { readonly status: HostStatus; readonly at: number } | undefined;
        readonly release?: string | undefined;
      }
    | undefined,
  /** Its last problem, and whether access over Tailscale is on, for why it is offline. */
  status: { readonly problem?: MachineProblem | undefined; readonly tailscale?: boolean } = {},
) => {
  const offline: OfflineReason | undefined =
    online !== undefined
      ? undefined
      : status.tailscale === false
        ? { kind: "tailscale-off" }
        : (status.problem ?? { kind: "never" });
  const release =
    online?.release ?? (status.problem?.kind === "mismatch" ? status.problem.release : undefined);
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    fingerprint: fingerprintOf(machine.publicKey),
    joinedAt: machine.joinedAt,
    confirmed: machine.confirmedAt !== undefined,
    ...(online === undefined ? {} : { onlineSince: online.since }),
    // Only while it is online: what its `claude auth status` said (the classification alone) and
    // which of its tools it found.
    ...(online?.status === undefined
      ? {}
      : {
          claudeSignIn: online.status.status.claudeSignIn,
          claudeSignInCheckedAt: online.status.at,
          tools: online.status.status.tools,
        }),
    ...(offline === undefined ? {} : { offline }),
    ...(release === undefined ? {} : { release }),
    ...(machine.sshTarget === undefined ? {} : { sshTarget: machine.sshTarget }),
  };
};
