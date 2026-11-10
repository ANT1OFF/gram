import type { KeyObject } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
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
import type { MachineUpdate } from "./machine-updates.ts";

/** How long a join link lasts, as a phone's pairing link does. */
export const JOIN_LIFETIME_MS = 15 * 60_000;
/** How many machines can be joined at once. */
export const MAX_MACHINES = 16;
/**
 * How many provisioned hosts can be registered at once, beside the joined machines: an embedding
 * control plane registers one per unit of work it places, so far more than a person joins.
 */
export const MAX_PROVISIONED = 256;
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
   * When this Gram last sent the machine a Claude token from `claude setup-token`, with the
   * user's consent; cleared once the machine deletes it. A time only: the token is never kept here.
   */
  readonly claudeTokenSetAt?: number;
  /**
   * The `[user@]host` Gram last installed it at over SSH (Add over SSH, or its update), so an
   * update can run that install again; absent for a machine that joined by the command.
   */
  readonly sshTarget?: string;
  /**
   * How it came to be here, which decides where it may dial; absent for a machine a person joined
   * with a link. `provisioned` is a host a control plane registered by its key (`provision`):
   * never asked with a join link, confirmed from the start, and taken only on the
   * provisioned-host listener, never the tailnet address. How a key was approved (this) and the
   * address its dials come in on (`DialRoute`) are kept apart, so another kind can pair them
   * differently.
   */
  readonly kind?: MachineKind;
}

/** How a machine other than a joined one came to be registered. */
export type MachineKind = "provisioned";

/** Whether a control plane registered it by its key. */
export const isProvisioned = (machine: Pick<PairedMachine, "kind">) =>
  machine.kind === "provisioned";

/** Where a machine of this kind may dial in. */
const routeOf = (machine: Pick<PairedMachine, "kind">): DialRoute =>
  isProvisioned(machine) ? "provisioned" : "joined";

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

/** What an embedding control plane registers a host with: its key, made on the host. */
export interface ProvisionRequest {
  readonly name: string;
  readonly platform: string;
  readonly publicKey: string;
}

export type ProvisionResult =
  /** `created` is false when this key was already registered as a provisioned host. */
  | {
      readonly kind: "provisioned";
      readonly machine: PairedMachine;
      readonly created: boolean;
    }
  | {
      readonly kind: "refused";
      readonly status: 400 | 409;
      readonly message: string;
    };

/** The way a dial came in: over the tailnet address, or over the provisioned-host listener. */
export type DialRoute = "joined" | "provisioned";

export type ConnectResult =
  | { readonly kind: "ok"; readonly machine: PairedMachine }
  | { readonly kind: "refused"; readonly status: 401 | 403 | 503; readonly message: string };

/** An accepted dial's nonce, and the last moment its dial is in the acceptance window. */
export type DialNonce = readonly [nonce: string, until: number];

/**
 * The accepted dials' nonces still in their window; `floor`, the latest signed time of any nonce
 * let go (or that couldn't be read), at or before which no dial is taken, so a clock set back
 * can't bring a forgotten dial back into its window; and `seen`, the latest time any run saw when
 * it accepted a dial, which a clock set back never lowers.
 */
export interface DialNonces {
  readonly nonces: ReadonlyArray<DialNonce>;
  readonly floor: number;
  readonly seen: number;
}

/**
 * The accepted dials' nonces, kept across restarts: a dial's signed headers replayed after the
 * main Gram restarts would otherwise be taken as new.
 */
export interface DialNonceStore {
  readonly read: () => DialNonces;
  readonly write: (nonces: DialNonces) => void;
  /**
   * The `seen` of the last write, when `read` throws: kept apart from what it holds, so a file
   * that can't be read still bounds the dials it took. Undefined when that can't be known either.
   */
  readonly lastSeen?: () => number | undefined;
}

export const NO_DIALS: DialNonces = { nonces: [], floor: 0, seen: 0 };

/** The names a machine or host can have. */
export const HOST_NAME = /^[\p{L}\p{N} ._'-]{1,64}$/u;
const NAME = HOST_NAME;
/** Names that mean this machine, in any case: `spawn_worker` runs here on them, and none can join. */
export const LOCAL_MACHINE_NAMES = ["local", "this machine"] as const;
export const namesThisMachine = (name: string) =>
  (LOCAL_MACHINE_NAMES as ReadonlyArray<string>).includes(name.trim().toLowerCase());
const PLATFORM = /^[a-z0-9]{1,16}$/;

/** Whether each kind is within its own limit. */
const withinLimits = (machines: ReadonlyArray<PairedMachine>) => {
  const provisioned = machines.filter(isProvisioned).length;
  return provisioned <= MAX_PROVISIONED && machines.length - provisioned <= MAX_MACHINES;
};

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
    (m["claudeTokenSetAt"] === undefined || Number.isSafeInteger(m["claudeTokenSetAt"])) &&
    (m["sshTarget"] === undefined ||
      (typeof m["sshTarget"] === "string" && SSH_TARGET.test(m["sshTarget"]))) &&
    // A provisioned host is confirmed when it is registered, and was never installed over SSH.
    (m["kind"] === undefined ||
      (m["kind"] === "provisioned" &&
        m["confirmedAt"] !== undefined &&
        m["sshTarget"] === undefined))
  );
};

/**
 * The joined machines in `<dataDir>/remote-access/machines.json`: private to this user, refused
 * when it isn't, replaced atomically. Only public keys are kept; there is no secret in it.
 */
export const fileMachineStore = (dataDir: string): PairedMachineStore => {
  const file = privateJsonFile(dataDir, "machines.json", 256 * 1024);
  const read = (): PairedMachine[] => {
    const value = file.read();
    if (value === undefined) return [];
    const record = value as Record<string, unknown> | null;
    if (
      typeof record !== "object" ||
      record === null ||
      record["version"] !== 1 ||
      !Array.isArray(record["machines"]) ||
      record["machines"].length > MAX_MACHINES + MAX_PROVISIONED ||
      !record["machines"].every(isMachine) ||
      !withinLimits(record["machines"])
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

const isNonce = (value: unknown): value is DialNonce =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  /^[a-f0-9]{32}$/.test(value[0]) &&
  Number.isSafeInteger(value[1]);

const dialNoncesPath = (dataDir: string) => join(dataDir, "remote-access", "dial-nonces.json");

/** The `seen` the nonces file's modified time holds, whether or not its content can be read. */
export const dialNoncesLastSeen = (dataDir: string): number | undefined => {
  try {
    // A second on, for a filesystem that keeps whole seconds.
    return Math.ceil(lstatSync(dialNoncesPath(dataDir)).mtimeMs) + 1000;
  } catch {
    return undefined;
  }
};

/** The accepted dials' nonces in `<dataDir>/remote-access/dial-nonces.json`, as the machines are. */
export const fileNonceStore = (dataDir: string): DialNonceStore => {
  const file = privateJsonFile(dataDir, "dial-nonces.json", 256 * 1024);
  return {
    read: () => {
      const value = file.read();
      if (value === undefined) return NO_DIALS;
      const record = value as Record<string, unknown> | null;
      if (
        typeof record !== "object" ||
        record === null ||
        record["version"] !== 1 ||
        !Number.isSafeInteger(record["floor"]) ||
        !Number.isSafeInteger(record["seen"]) ||
        !Array.isArray(record["nonces"]) ||
        record["nonces"].length > NONCES_KEPT ||
        !record["nonces"].every(isNonce)
      )
        throw new Error("Dial nonce storage is invalid");
      return {
        nonces: record["nonces"] as DialNonce[],
        floor: record["floor"] as number,
        seen: record["seen"] as number,
      };
    },
    // Its modified time is `seen`, which survives what makes the content unreadable. It is set
    // before the file replaces the old one, so a write that fails never lowers it.
    write: ({ nonces, floor, seen }) => file.write({ version: 1, floor, seen, nonces }, seen),
    lastSeen: () => dialNoncesLastSeen(dataDir),
  };
};

export const memoryNonceStore = (initial: DialNonces = NO_DIALS) => {
  let kept = initial;
  return {
    read: () => kept,
    write: (next: DialNonces) => {
      kept = { ...next, nonces: [...next.nonces] };
    },
  } satisfies DialNonceStore;
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
export const createPairedMachines = (
  store: PairedMachineStore,
  now: () => number = Date.now,
  nonceStore: DialNonceStore = memoryNonceStore(),
) => {
  let machines = store.read();
  let invitation: { code: string; origin: string; expiresAt: number } | undefined;
  /** Recent dials' nonces with when they stop mattering, as the last run left them. */
  const nonces = new Map<string, number>();
  /** No dial signed at or before this is taken; the latest time a dial was accepted at. */
  let floor = 0;
  let seen = 0;
  /**
   * Set while the last run's dials can't be bounded at all: then none is taken, and each dial
   * tries again to load them, so storage put right is used without a restart.
   */
  let blind = false;
  /** Loads the last run's nonces, or a bound on them; false when there is neither. */
  const load = () => {
    try {
      const kept = nonceStore.read();
      ({ floor, seen } = kept);
      for (const [nonce, until] of kept.nonces) nonces.set(nonce, until);
      return true;
    } catch {
      // The last run's nonces are unknown, but every dial it accepted was signed at most the
      // skew past the latest time it saw, or past now: none of those is taken, whatever the
      // clock did.
      const last = nonceStore.lastSeen?.();
      if (last === undefined) return false;
      floor = Math.max(now(), last) + CONNECT_SKEW_MS;
      seen = floor;
      return true;
    }
  };
  blind = !load();
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
  const record = (
    nonce: string,
    signed: number,
    /** The time the dial was checked at: one reading, so pruning can't pass the dial's window. */
    at: number,
  ): "ok" | "stale" | "replayed" | "full" | "unsaved" => {
    const until = signed + CONNECT_SKEW_MS;
    // Let go once past their window, which the skew check refuses, and the floor raised past
    // them, so a clock set back later doesn't bring them into it again.
    for (const [kept, expires] of nonces)
      if (expires < at) {
        nonces.delete(kept);
        floor = Math.max(floor, expires - CONNECT_SKEW_MS);
      }
    if (signed <= floor) return "stale";
    if (nonces.has(nonce)) return "replayed";
    if (nonces.size >= NONCES_KEPT) return "full";
    // Kept in memory even when saving fails, so this run still refuses its replay.
    nonces.set(nonce, until);
    seen = Math.max(seen, at);
    try {
      nonceStore.write({ nonces: [...nonces], floor, seen });
    } catch {
      return "unsaved";
    }
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
      if (namesThisMachine(request.name))
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
      if (machines.filter((machine) => !isProvisioned(machine)).length >= MAX_MACHINES)
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
    /**
     * Registers a host by the key it made, confirmed from the start: no join link and no
     * fingerprint to compare, because whoever may call this already decides which hosts get work.
     * Registering the same key again changes nothing. A key that joined with a link is refused,
     * so this never confirms a machine a person hasn't.
     */
    provision: (request: ProvisionRequest): ProvisionResult => {
      if (!NAME.test(request.name) || !PLATFORM.test(request.platform))
        return {
          kind: "refused",
          status: 400,
          message: "The host's name isn't valid.",
        };
      if (namesThisMachine(request.name))
        return {
          kind: "refused",
          status: 400,
          message: "That name is reserved for this machine. Choose another.",
        };
      if (publicKeyFrom(request.publicKey) === undefined)
        return {
          kind: "refused",
          status: 400,
          message: "The host's key isn't valid.",
        };
      const id = hostIdOf(request.publicKey);
      const existing = byId(id);
      if (existing !== undefined)
        return isProvisioned(existing)
          ? { kind: "provisioned", machine: existing, created: false }
          : {
              kind: "refused",
              status: 409,
              message: "That key belongs to a machine that joined with a link.",
            };
      if (machines.filter(isProvisioned).length >= MAX_PROVISIONED)
        return {
          kind: "refused",
          status: 409,
          message: `Gram can have ${MAX_PROVISIONED} provisioned hosts; remove one first.`,
        };
      const at = now();
      const machine: PairedMachine = {
        id,
        name: request.name,
        platform: request.platform,
        publicKey: request.publicKey,
        joinedAt: at,
        confirmedAt: at,
        kind: "provisioned",
      };
      save([...machines, machine]);
      return { kind: "provisioned", machine, created: true };
    },
    confirm: (id: string): PairedMachine | undefined => {
      const machine = byId(id);
      if (machine === undefined) return undefined;
      if (machine.confirmedAt !== undefined) return machine;
      const confirmed = { ...machine, confirmedAt: now() };
      save(machines.map((m) => (m === machine ? confirmed : m)));
      return confirmed;
    },
    /** Records that the machine took a Claude token now, or (`false`) that it deleted it. */
    tokenSent: (id: string, sent: boolean): void => {
      const machine = byId(id);
      if (machine === undefined) return;
      const { claudeTokenSetAt: _was, ...rest } = machine;
      const next: PairedMachine = sent ? { ...rest, claudeTokenSetAt: now() } : rest;
      save(machines.map((m) => (m === machine ? next : m)));
    },
    /** Records that Gram installed the machine at `target` over SSH, for its updates. */
    installedOverSsh: (id: string, target: string): void => {
      const machine = byId(id);
      if (
        machine === undefined ||
        isProvisioned(machine) ||
        !SSH_TARGET.test(target) ||
        machine.sshTarget === target
      )
        return;
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
     * nonce not seen before, and the machine's own signature over all of it and `origin`. A
     * provisioned host is taken only on the provisioned route and a joined machine only on the
     * joined one; on the other, either is as unknown as a key never registered.
     */
    authorizeConnect: (
      origin: string,
      headers: Readonly<Record<string, string | undefined>>,
      route: DialRoute = "joined",
    ): ConnectResult => {
      const claim = connectClaimOf(origin, headers);
      if (claim === undefined)
        return { kind: "refused", status: 401, message: "unauthorized: signed dial required" };
      const named = byId(claim.hostId);
      const machine = named !== undefined && routeOf(named) === route ? named : undefined;
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
      // At or before a nonce let go, or the bound on a history it couldn't read: see `DialNonces`.
      if (claim.time <= floor)
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      if (!verifyConnect(key, claim, claim.signature)) {
        // Anyone can send one, so it never replaces a reason the machine's own key stood behind.
        const kept = problems.get(machine.id)?.kind;
        if (kept === undefined || kept === "bad-signature")
          note(machine.id, { kind: "bad-signature", at });
        return { kind: "refused", status: 401, message: "unauthorized: bad signature" };
      }
      // Before its nonce is kept: a machine not confirmed yet neither spends the dials' room nor
      // writes them, and its replay is refused all the same.
      if (machine.confirmedAt === undefined) {
        note(machine.id, { kind: "unconfirmed", at });
        return { kind: "refused", status: 403, message: "forbidden: confirm this machine first" };
      }
      // Retried only for a confirmed machine's signed dial; `record` checks it against the floor
      // a load sets.
      if (blind) blind = !load();
      if (blind)
        return { kind: "refused", status: 503, message: "unavailable: dial history unreadable" };
      // Checked after the signature, so a forged dial can't spend a real one's nonce.
      const nonce = record(claim.nonce, claim.time, at);
      if (nonce === "stale")
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      if (nonce === "replayed")
        return { kind: "refused", status: 401, message: "unauthorized: dial replayed" };
      if (nonce === "full")
        return { kind: "refused", status: 401, message: "unauthorized: too many dials; wait" };
      // Unsaved, it could be replayed after a restart: refused rather than taken on that risk.
      if (nonce === "unsaved")
        return { kind: "refused", status: 503, message: "unavailable: dial couldn't be recorded" };
      return { kind: "ok", machine };
    },
  };
};

export type PairedMachines = ReturnType<typeof createPairedMachines>;

/**
 * Why access over Tailscale is switched on but no machine can dial in: Tailscale on this computer
 * is missing, signed out, stopped, without HTTPS certificates or not answering, or Gram couldn't
 * set up its Serve listener (`serve`).
 */
export type TailscaleDown = "missing" | "signed-out" | "stopped" | "no-https" | "error" | "serve";

/** Whether machines can dial this Gram over Tailscale: on, switched off, or on but down and why. */
export type DialAccess = "on" | "off" | TailscaleDown;

/**
 * Why a machine is offline, as the settings page says it: its last problem, or that access over
 * Tailscale is off or down (so no machine can dial), or that it hasn't dialled since this Gram
 * started.
 */
export type OfflineReason =
  | MachineProblem
  | { readonly kind: "tailscale-off" }
  | { readonly kind: "tailscale-down"; readonly cause: TailscaleDown }
  | { readonly kind: "never" };

/** A machine as the settings page lists it: no key, its fingerprint instead. */
export const machineView = (
  machine: PairedMachine,
  online:
    | {
        readonly since: number;
        readonly status?: { readonly status: HostStatus; readonly at: number } | undefined;
        readonly release?: string | undefined;
        /** Whether its host updates itself over its connection (`host.update.*`). */
        readonly selfUpdate?: boolean;
      }
    | undefined,
  /**
   * Its last problem, and whether access over Tailscale is on, for why it is offline; its update,
   * while one runs or since one ended.
   */
  status: {
    readonly problem?: MachineProblem | undefined;
    readonly tailscale?: DialAccess;
    readonly update?: MachineUpdate | undefined;
  } = {},
) => {
  // A provisioned host dials its own listener, whatever access over Tailscale is.
  const access = isProvisioned(machine) ? "on" : (status.tailscale ?? "on");
  // Tailscale down here explains a lost connection better than the loss itself.
  const offline: OfflineReason | undefined =
    online !== undefined
      ? undefined
      : access === "off"
        ? { kind: "tailscale-off" }
        : access !== "on"
          ? { kind: "tailscale-down", cause: access }
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
    ...(machine.claudeTokenSetAt === undefined
      ? {}
      : { claudeTokenSetAt: machine.claudeTokenSetAt }),
    // Only while it is online: what its `claude auth status` said (the classification alone) and
    // which of its tools it found.
    ...(online?.status === undefined
      ? {}
      : {
          claudeSignIn: online.status.status.claudeSignIn,
          claudeSignInCheckedAt: online.status.at,
          tools: online.status.status.tools,
          // What its Claude Code lists, for resolving a worker's tier there; absent from an
          // older host, which then resolves against this machine's lists.
          ...(online.status.status.models === undefined
            ? {}
            : { models: online.status.status.models }),
        }),
    ...(offline === undefined ? {} : { offline }),
    ...(release === undefined ? {} : { release }),
    ...(machine.sshTarget === undefined ? {} : { sshTarget: machine.sshTarget }),
    ...(machine.kind === undefined ? {} : { kind: machine.kind }),
    ...(online?.selfUpdate === true ? { selfUpdate: true } : {}),
    ...(status.update === undefined ? {} : { update: status.update }),
  };
};
