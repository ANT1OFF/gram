import type { KeyObject } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type HostId, type HostStatus, hostedOrigin } from "@gram/contracts";
import { makeLaunchToken, tokensEqual } from "../http/auth.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { makeDialNonceRecord } from "./dial-nonce-record.ts";
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
const NONCES_KEPT = 4096;
/**
 * How many of one machine's dials can be in their window at once: several times what a host
 * dialling again at its slowest (every 30 seconds) makes, and few enough that every machine at
 * this limit together still leaves room in `NONCES_KEPT`. Past it that machine waits, so one
 * machine's key, however it is used, can't fill the room the others' dials need. Counted by
 * this run alone: after a restart a machine has its share again beside the dials the last run
 * took, which only many keys spent together around a restart could turn into a full set.
 */
export const DIALS_PER_MACHINE = 12;

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
  /**
   * A provisioned host started for one person, by an embedder that provisions hosts on demand:
   * the stable subject that person signs in with (fronted sign-in), or one no person signs in
   * with, which leaves it to the server's own work. Only that owner's threads are placed on it,
   * and only they reach it. Always given with `onDemand`; absent, with no kind, any work may go on
   * it, as before. One on demand from before owners were required is closed (`holderOf`).
   */
  readonly owner?: string;
  /**
   * The one person who may reach it beside its owner's own threads, where its owner is no
   * person's subject: a host started for a run that acts for someone, owned by the run so that
   * its threads link to nothing of that person's, and reached by that person alone. Only with an
   * owner; never makes it theirs to place new work on or to link to (`host/ownership.ts`).
   */
  readonly person?: string;
  /**
   * Who besides its owner and `person` may answer the requests its threads wait on (an approval,
   * a question): `members`, any member a fronted sign-in states, as for a host an embedder
   * started for a subject no person signs in with, whose own decisions say who approves. It opens
   * nothing else of the machine to them: sending to its threads, steering, placing or linking work
   * stay its owner's and `person`'s (`host/ownership.ts`). Only with an owner.
   */
  readonly answeredBy?: "members";
  /**
   * What an on-demand host is for: `personal`, the person's own host for work in a folder or a
   * repository, or `thread`, a host for the threads placed on it by name (and their workers),
   * such as one an embedder started for a single run, or `worker`, a host its owner's
   * orchestrator started for its own workers (`embedding/worker-machines.ts`). None is ever
   * anyone's default machine (`host/headless.ts`).
   */
  readonly onDemand?: OnDemandKind;
  /**
   * The hosted server a worker host came through, for a desktop Gram signed in to one
   * (`embedding/signed-in-workers.ts`): its origin, which the host signs its dials for and which
   * only that server's relay carries (`DialRoute` `relayed`). Only with `onDemand: "worker"` and no
   * owner: on the desktop it is the desktop's, like a joined machine, and placed on only by its
   * orchestrators' `sandbox`.
   */
  readonly via?: string;
  /**
   * The sign-in at `via` it was asked for under (`WorkerMachineServer.account`): it is asked
   * after, released and stopped only under that sign-in. Absent on one registered before.
   */
  readonly viaAccount?: string;
  /**
   * The server at `via` as it named itself when the host was asked for (`MachineState.hosted`):
   * only with `via`. Absent on one registered before.
   */
  readonly viaName?: string;
  /**
   * Since when a relayed worker host is set aside (epoch ms): stopped there and needed by no thread
   * here, so it is neither relayed nor listed, and kept whole (its key, id and stop records) for
   * whatever takes it up again. Only with `via`.
   */
  readonly setAside?: number;
}

const isViaName = (name: unknown): name is string =>
  typeof name === "string" && name.trim() !== "" && name.length <= 128;

/** What an embedder started a host on demand for. */
export type OnDemandKind = "personal" | "thread" | "worker";

/** How a machine other than a joined one came to be registered. */
export type MachineKind = "provisioned";

/** Whether a control plane registered it by its key. */
export const isProvisioned = (machine: Pick<PairedMachine, "kind">) =>
  machine.kind === "provisioned";

const sameName = (machine: Pick<PairedMachine, "name">, name: string) =>
  machine.name.trim().toLowerCase() === name.trim().toLowerCase();

const routeOf = (machine: Pick<PairedMachine, "kind" | "via">): DialRoute =>
  machine.via !== undefined ? "relayed" : isProvisioned(machine) ? "provisioned" : "joined";

/**
 * A hosted server's origin, as a relayed host's `via`: as the person signed in to it (`https:`,
 * or loopback for tests), nothing after the host and port.
 */
export const isRelayOrigin = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 512 && hostedOrigin(value) === value;

const isAccountMark = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

/**
 * The last reason a joined machine dropped or was refused, as this Gram saw it since it started:
 * kept in memory only, and never anything from the dial itself (its signature, nonce or key).
 */
export type MachineProblem =
  | { readonly kind: "unconfirmed"; readonly at: number }
  | { readonly kind: "bad-signature"; readonly at: number }
  | { readonly kind: "clock"; readonly at: number; readonly skewMs: number }
  | {
      readonly kind: "mismatch";
      readonly at: number;
      readonly protocol: number;
      readonly release?: string;
      readonly missing?: ReadonlyArray<string>;
    }
  | { readonly kind: "no-hello"; readonly at: number }
  | { readonly kind: "lost"; readonly at: number }
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
  /** Whom the host is for (`PairedMachine.owner`): always with `onDemand`. */
  readonly owner?: string;
  /** The person who may reach it beside its owner (`PairedMachine.person`): only with an owner. */
  readonly person?: string;
  /** Who besides may answer its threads' requests (`PairedMachine.answeredBy`): only with an owner. */
  readonly answeredBy?: "members";
  readonly onDemand?: OnDemandKind;
  /** The hosted server it came through (`PairedMachine.via`): only for a worker host with no owner. */
  readonly via?: string;
  /** The sign-in there it was asked for under (`PairedMachine.viaAccount`): only with `via`. */
  readonly viaAccount?: string;
  /** The server at `via`, by its own name (`PairedMachine.viaName`): only with `via`. */
  readonly viaName?: string;
}

export type ProvisionResult =
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

/**
 * The way a dial came in: over the tailnet address, over the provisioned-host listener, or over a
 * hosted server's relay that the desktop app carries (`embedding/signed-in-workers.ts`).
 */
export type DialRoute = "joined" | "provisioned" | "relayed";

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
    (m["kind"] === undefined ||
      (m["kind"] === "provisioned" &&
        m["confirmedAt"] !== undefined &&
        m["sshTarget"] === undefined)) &&
    (m["via"] === undefined ||
      (m["kind"] === "provisioned" &&
        isRelayOrigin(m["via"]) &&
        m["onDemand"] === "worker" &&
        m["owner"] === undefined)) &&
    (m["viaAccount"] === undefined || (m["via"] !== undefined && isAccountMark(m["viaAccount"]))) &&
    (m["viaName"] === undefined || (m["via"] !== undefined && isViaName(m["viaName"]))) &&
    (m["setAside"] === undefined ||
      (m["via"] !== undefined && Number.isSafeInteger(m["setAside"]))) &&
    (m["answeredBy"] === undefined || (m["answeredBy"] === "members" && m["owner"] !== undefined))
  );
};

const machinesIn = (value: unknown, provisioned: boolean, most: number): PairedMachine[] => {
  if (value === undefined) return [];
  const record = value as Record<string, unknown> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    record["version"] !== 1 ||
    !Array.isArray(record["machines"]) ||
    record["machines"].length > most ||
    !record["machines"].every(
      (machine) => isMachine(machine) && isProvisioned(machine) === provisioned,
    )
  )
    throw new Error("Joined machines storage is invalid");
  return record["machines"] as PairedMachine[];
};

/**
 * The joined machines in `<dataDir>/remote-access/machines.json`: private to this user, refused
 * when it isn't, replaced atomically. Only public keys are kept; there is no secret in it.
 * Provisioned hosts are kept beside it in `provisioned-hosts.json`, never in the same file: a
 * build from before they existed reads `machines.json` alone, and would take any entry in it for
 * a machine a person confirmed. Neither file takes an entry of the other's kind.
 */
export const fileMachineStore = (dataDir: string): PairedMachineStore => {
  const file = privateJsonFile(dataDir, "machines.json", 64 * 1024);
  const hostsFile = privateJsonFile(dataDir, "provisioned-hosts.json", 256 * 1024);
  const read = (): PairedMachine[] => [
    ...machinesIn(file.read(), false, MAX_MACHINES),
    ...machinesIn(hostsFile.read(), true, MAX_PROVISIONED),
  ];
  return {
    read,
    write: (machines) => {
      const kept = read();
      const joined = machines.filter((machine) => !isProvisioned(machine));
      const provisioned = machines.filter(isProvisioned);
      const changed = (kind: boolean, next: ReadonlyArray<PairedMachine>) =>
        JSON.stringify(kept.filter((machine) => isProvisioned(machine) === kind)) !==
        JSON.stringify(next);
      if (changed(false, joined) || file.read() === undefined)
        file.write({ version: 1, machines: joined });
      if (changed(true, provisioned)) hostsFile.write({ version: 1, machines: provisioned });
    },
  };
};

const HOST_DIAL_NONCE = /^[a-f0-9]{32}$/;

const isNonceOf =
  (shape: RegExp) =>
  (value: unknown): value is DialNonce =>
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    shape.test(value[0]) &&
    Number.isSafeInteger(value[1]);

const DIAL_NONCES_FILE = "dial-nonces.json";

const dialNoncesPath = (dataDir: string, name: string = DIAL_NONCES_FILE) =>
  join(dataDir, "remote-access", name);

/** The `seen` the nonces file's modified time holds, whether or not its content can be read. */
export const dialNoncesLastSeen = (
  dataDir: string,
  name: string = DIAL_NONCES_FILE,
): number | undefined => {
  try {
    return Math.ceil(lstatSync(dialNoncesPath(dataDir, name)).mtimeMs) + 1000;
  } catch {
    return undefined;
  }
};

/**
 * The accepted dials' nonces in `<dataDir>/remote-access/dial-nonces.json`, as the machines are.
 * Another kind of dial keeps its own under `name`, with nonces of its own `shape`.
 */
export const fileNonceStore = (
  dataDir: string,
  name: string = DIAL_NONCES_FILE,
  shape: RegExp = HOST_DIAL_NONCE,
): DialNonceStore => {
  const file = privateJsonFile(dataDir, name, 256 * 1024);
  const isNonce = isNonceOf(shape);
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
    write: ({ nonces, floor, seen }) => file.write({ version: 1, floor, seen, nonces }, seen),
    lastSeen: () => dialNoncesLastSeen(dataDir, name),
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
  onChange: () => void = () => {},
) => {
  let machines = store.read();
  let invitation: { code: string; origin: string; expiresAt: number } | undefined;
  const dials = makeDialNonceRecord(nonceStore, now, {
    skewMs: CONNECT_SKEW_MS,
    most: NONCES_KEPT,
    perKey: DIALS_PER_MACHINE,
  });
  const problems = new Map<string, MachineProblem>();
  const note = (id: string, problem: MachineProblem | undefined) => {
    if (problem === undefined) {
      if (!problems.delete(id)) return;
    } else if (byId(id) !== undefined) problems.set(id, problem);
    else return;
    onChange();
  };
  const save = (next: PairedMachine[]) => {
    store.write(next);
    machines = next;
    onChange();
  };
  const forget = (next: PairedMachine[]) => {
    machines = next;
    try {
      store.write(next);
    } finally {
      onChange();
    }
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
      if (
        machines.some(
          (machine) =>
            isProvisioned(machine) &&
            (sameName(machine, request.name) || machine.id === request.name.trim().toLowerCase()),
        )
      )
        return {
          kind: "refused",
          status: 409,
          message:
            "Another machine already has that name. Choose another with gram-host join --name.",
        };
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
     * Registering the same key again, with the same name, changes nothing. A key that joined with a link is refused,
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
      if (request.viaAccount !== undefined && !isAccountMark(request.viaAccount))
        return { kind: "refused", status: 400, message: "That sign-in mark isn't valid." };
      if (
        request.viaName !== undefined &&
        (request.via === undefined || !isViaName(request.viaName))
      )
        return { kind: "refused", status: 400, message: "That server's name isn't valid." };
      if (request.via !== undefined) {
        if (
          !isRelayOrigin(request.via) ||
          request.onDemand !== "worker" ||
          request.owner !== undefined ||
          request.person !== undefined
        )
          return {
            kind: "refused",
            status: 400,
            message: "A relayed host is a worker host with no owner, from one hosted server.",
          };
      } else if (
        (request.onDemand === undefined) !== (request.owner === undefined) ||
        (request.person !== undefined && request.owner === undefined) ||
        (request.answeredBy !== undefined && request.owner === undefined)
      )
        return {
          kind: "refused",
          status: 400,
          message: "An on-demand host names its kind and its owner.",
        };
      const id = hostIdOf(request.publicKey);
      const existing = byId(id);
      if (existing !== undefined) {
        if (!isProvisioned(existing))
          return {
            kind: "refused",
            status: 409,
            message: "That key belongs to a machine that joined with a link.",
          };
        return existing.name === request.name &&
          existing.platform === request.platform &&
          existing.owner === request.owner &&
          existing.person === request.person &&
          existing.answeredBy === request.answeredBy &&
          existing.onDemand === request.onDemand &&
          existing.via === request.via &&
          existing.viaAccount === request.viaAccount
          ? { kind: "provisioned", machine: existing, created: false }
          : {
              kind: "refused",
              status: 409,
              message: `That key is already registered as "${existing.name}". Remove it first to change that.`,
            };
      }
      if (
        /^m-[a-f0-9]{24}$/i.test(request.name.trim()) ||
        machines.some((machine) => sameName(machine, request.name))
      )
        return {
          kind: "refused",
          status: 409,
          message: "Another machine already has that name. Choose another.",
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
        ...(request.owner === undefined ? {} : { owner: request.owner }),
        ...(request.person === undefined ? {} : { person: request.person }),
        ...(request.answeredBy === undefined ? {} : { answeredBy: request.answeredBy }),
        ...(request.onDemand === undefined ? {} : { onDemand: request.onDemand }),
        ...(request.via === undefined ? {} : { via: request.via }),
        ...(request.via === undefined || request.viaAccount === undefined
          ? {}
          : { viaAccount: request.viaAccount }),
        ...(request.viaName === undefined ? {} : { viaName: request.viaName }),
      };
      save([...machines, machine]);
      return { kind: "provisioned", machine, created: true };
    },
    /**
     * Moves every machine relayed from `origin` under the sign-in mark `from` to the mark `to`,
     * in one write: the same sign-in, whose mark became its organisation's. No other changes.
     */
    remark: (origin: string, from: string, to: string): number => {
      if (!isAccountMark(to)) return 0;
      let moved = 0;
      const next = machines.map((machine) => {
        if (machine.via !== origin || machine.viaAccount !== from) return machine;
        moved += 1;
        return { ...machine, viaAccount: to };
      });
      if (moved > 0) save(next);
      return moved;
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
    /**
     * Sets a relayed worker host aside since `at`, or takes it back with undefined
     * (`PairedMachine.setAside`). Nothing else of it changes.
     */
    setAside: (id: string, at: number | undefined): void => {
      const machine = byId(id);
      if (machine?.via === undefined || machine.setAside === at) return;
      const { setAside: _was, ...rest } = machine;
      const next: PairedMachine = at === undefined ? rest : { ...rest, setAside: at };
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
      dials.forget(id);
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
        if (verifyConnect(key, claim, claim.signature))
          note(machine.id, { kind: "clock", at, skewMs: claim.time - at });
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      }
      if (dials.stale(claim.time))
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      if (!verifyConnect(key, claim, claim.signature)) {
        const kept = problems.get(machine.id)?.kind;
        if (kept === undefined || kept === "bad-signature")
          note(machine.id, { kind: "bad-signature", at });
        return { kind: "refused", status: 401, message: "unauthorized: bad signature" };
      }
      if (machine.confirmedAt === undefined) {
        note(machine.id, { kind: "unconfirmed", at });
        return { kind: "refused", status: 403, message: "forbidden: confirm this machine first" };
      }
      if (!dials.ready())
        return { kind: "refused", status: 503, message: "unavailable: dial history unreadable" };
      const nonce = dials.record(machine.id, claim.nonce, claim.time, at);
      if (nonce === "stale")
        return { kind: "refused", status: 401, message: "unauthorized: dial out of date" };
      if (nonce === "replayed")
        return { kind: "refused", status: 401, message: "unauthorized: dial replayed" };
      if (nonce === "full")
        return { kind: "refused", status: 401, message: "unauthorized: too many dials; wait" };
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
  status: {
    readonly problem?: MachineProblem | undefined;
    readonly tailscale?: DialAccess;
    readonly update?: MachineUpdate | undefined;
  } = {},
) => {
  const access = isProvisioned(machine) ? "on" : (status.tailscale ?? "on");
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
    ...(online?.status === undefined
      ? {}
      : {
          claudeSignIn: online.status.status.claudeSignIn,
          claudeSignInCheckedAt: online.status.at,
          tools: online.status.status.tools,
          ...(online.status.status.models === undefined
            ? {}
            : { models: online.status.status.models }),
          ...(online.status.status.codex === undefined
            ? {}
            : { codex: online.status.status.codex }),
          ...(online.status.status.opencode === undefined
            ? {}
            : { opencode: online.status.status.opencode }),
          ...(online.status.status.grok === undefined ? {} : { grok: online.status.status.grok }),
          ...(online.status.status.antigravity === undefined
            ? {}
            : { antigravity: online.status.status.antigravity }),
        }),
    ...(offline === undefined ? {} : { offline }),
    ...(release === undefined ? {} : { release }),
    ...(machine.sshTarget === undefined ? {} : { sshTarget: machine.sshTarget }),
    ...(machine.kind === undefined ? {} : { kind: machine.kind }),
    ...(machine.owner === undefined ? {} : { owner: machine.owner }),
    ...(machine.person === undefined ? {} : { person: machine.person }),
    ...(machine.answeredBy === undefined ? {} : { answeredBy: machine.answeredBy }),
    ...(machine.onDemand === undefined ? {} : { onDemand: machine.onDemand }),
    ...(machine.via === undefined ? {} : { via: machine.via }),
    ...(machine.viaAccount === undefined ? {} : { viaAccount: machine.viaAccount }),
    ...(online?.selfUpdate === true ? { selfUpdate: true } : {}),
    ...(status.update === undefined ? {} : { update: status.update }),
  };
};
