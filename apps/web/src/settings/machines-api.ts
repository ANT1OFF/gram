/**
 * The machines joined to this Gram, managed over plain same-origin POSTs that the server's auth
 * layer answers itself, as phone access is: a paired phone or a joined machine can never reach
 * them.
 */
export class MachinesError extends Error {}

/** A joined machine as the settings page lists it. */
export interface JoinedMachine {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  /** Five groups of four hex digits, from the machine's key; `gram-host join` prints the same. */
  readonly fingerprint: string;
  readonly joinedAt: number;
  readonly confirmed: boolean;
  /** Set while it is connected. */
  readonly onlineSince?: number;
  /** Why it is offline, as this Gram last saw it; set only while it isn't connected. */
  readonly offline?: OfflineReason;
  /** The Gram release its host said it runs, while online or when it couldn't connect. */
  readonly release?: string;
  /** The `[user@]host` Gram installed it at over SSH, which its update runs again. */
  readonly sshTarget?: string;
}

/**
 * Why a joined machine is offline: the last reason it dropped or was refused since this Gram
 * started, that access over Tailscale is off, or that it hasn't dialled since. Times are epoch ms.
 */
export type OfflineReason =
  | { readonly kind: "never" }
  | { readonly kind: "tailscale-off" }
  | { readonly kind: "unconfirmed"; readonly at: number }
  | { readonly kind: "bad-signature"; readonly at: number }
  /** Its clock against this machine's: positive when it is ahead. */
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

export interface MachinesStatus {
  readonly machines: ReadonlyArray<JoinedMachine>;
  /** A join link waiting to be used. */
  readonly joinLink?: { readonly expiresAt: number };
  /** This Gram's release, absent when it runs from source. */
  readonly release?: string;
  /** The host protocol this Gram speaks. */
  readonly protocol?: number;
  /** What updates a joined machine when run there; set while access over Tailscale is on. */
  readonly updateCommand?: string;
}

export interface JoinLink {
  readonly url: string;
  readonly expiresAt: number;
}

const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const refusal = async (response: Response, fallback: string): Promise<MachinesError> => {
  const text = await response.text().catch(() => "");
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && "message" in value)
      return new MachinesError(String(value.message));
  } catch {
    // Plain text.
  }
  return new MachinesError(text.trim() !== "" && text.length < 200 ? text : fallback);
};

const isMachine = (value: unknown): value is JoinedMachine => {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m["id"] === "string" &&
    typeof m["name"] === "string" &&
    typeof m["platform"] === "string" &&
    typeof m["fingerprint"] === "string" &&
    typeof m["joinedAt"] === "number" &&
    typeof m["confirmed"] === "boolean" &&
    (m["onlineSince"] === undefined || typeof m["onlineSince"] === "number") &&
    (m["offline"] === undefined || isOffline(m["offline"])) &&
    (m["release"] === undefined || typeof m["release"] === "string") &&
    (m["sshTarget"] === undefined || typeof m["sshTarget"] === "string")
  );
};

const REASONS = new Set([
  "never",
  "tailscale-off",
  "unconfirmed",
  "bad-signature",
  "clock",
  "mismatch",
  "no-hello",
  "lost",
  "moved",
]);

const isOffline = (value: unknown): value is OfflineReason => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r["kind"] !== "string" || !REASONS.has(r["kind"])) return false;
  if (r["kind"] === "never" || r["kind"] === "tailscale-off") return true;
  if (typeof r["at"] !== "number") return false;
  if (r["kind"] === "clock") return typeof r["skewMs"] === "number";
  if (r["kind"] === "mismatch")
    return (
      typeof r["protocol"] === "number" &&
      (r["release"] === undefined || typeof r["release"] === "string") &&
      (r["missing"] === undefined ||
        (Array.isArray(r["missing"]) && r["missing"].every((m) => typeof m === "string")))
    );
  return true;
};

const status = async (response: Response, fallback: string): Promise<MachinesStatus> => {
  if (!response.ok) throw await refusal(response, fallback);
  const value = (await response.json()) as {
    machines?: unknown;
    joinLink?: unknown;
    release?: unknown;
    protocol?: unknown;
    updateCommand?: unknown;
  };
  if (!Array.isArray(value.machines) || !value.machines.every(isMachine))
    throw new MachinesError(fallback);
  const link = value.joinLink as { expiresAt?: unknown } | undefined;
  return {
    machines: value.machines,
    ...(typeof link?.expiresAt === "number" ? { joinLink: { expiresAt: link.expiresAt } } : {}),
    ...(typeof value.release === "string" ? { release: value.release } : {}),
    ...(typeof value.protocol === "number" ? { protocol: value.protocol } : {}),
    ...(typeof value.updateCommand === "string" ? { updateCommand: value.updateCommand } : {}),
  };
};

/** The query the Machines page and the new-thread machine picker share. */
export const MACHINES_KEY = ["machines.status"] as const;

export const machinesApi = {
  list: async () => status(await post("/machines/list"), "Couldn't read the machines"),
  confirm: async (id: string) =>
    status(await post("/machines/confirm", { id }), "Couldn't confirm the machine"),
  remove: async (id: string) =>
    status(await post("/machines/remove", { id }), "Couldn't remove the machine"),
  /** A one-time join link, or `tailscale-off` while access over Tailscale is off. */
  joinLink: async (): Promise<JoinLink | "tailscale-off" | "ssh-running"> => {
    const response = await post("/machines/join-link");
    if (response.status === 409)
      return (await response.text().catch(() => "")).includes('"ssh-running"')
        ? "ssh-running"
        : "tailscale-off";
    if (!response.ok) throw await refusal(response, "Couldn't make a join link");
    const value = (await response.json()) as { url?: unknown; expiresAt?: unknown };
    if (typeof value.url !== "string" || typeof value.expiresAt !== "number")
      throw new MachinesError("Couldn't make a join link");
    return { url: value.url, expiresAt: value.expiresAt };
  },
  /**
   * Runs the install over SSH again on a machine Gram added that way: it moves the machine's
   * service to this Gram's release and keeps the join. Minutes, while it downloads Gram there.
   */
  update: async (id: string): Promise<MachinesStatus & { readonly output: string }> => {
    const response = await post("/machines/update", { id });
    const text = await response.text().catch(() => "");
    let value: { message?: unknown; output?: unknown; reason?: unknown } = {};
    try {
      value = JSON.parse(text) as typeof value;
    } catch {
      // Plain text.
    }
    const output = typeof value.output === "string" ? value.output : "";
    if (!response.ok)
      throw new SshJoinError(
        typeof value.message === "string" ? value.message : "Couldn't update the machine",
        output,
        value.reason === "ssh-running",
      );
    return {
      ...(await status(new Response(text, { status: 200 }), "Couldn't update the machine")),
      output,
    };
  },
  /** The hosts in this computer's SSH config, for the Add over SSH picker. */
  sshHosts: async (): Promise<ReadonlyArray<string>> => {
    const response = await post("/machines/ssh-hosts");
    if (!response.ok) return [];
    const value = (await response.json()) as { hosts?: unknown };
    return Array.isArray(value.hosts)
      ? value.hosts.filter((host): host is string => typeof host === "string")
      : [];
  },
  /**
   * Installs and joins `target` over this computer's SSH, confirming it when the key that joined is
   * the one the install printed. Minutes, while it downloads Gram there.
   */
  sshJoin: async (
    target: string,
  ): Promise<
    MachinesStatus & {
      /** The machine confirmed, or `rejoined` when it had joined before and its service moved. */
      readonly joined: string;
      /** What went wrong after it joined and was confirmed, such as its service not starting. */
      readonly problem?: string;
      readonly output: string;
    }
  > => {
    const response = await post("/machines/ssh-join", { target });
    const text = await response.text().catch(() => "");
    let value: {
      message?: unknown;
      output?: unknown;
      joined?: unknown;
      problem?: unknown;
      reason?: unknown;
    } = {};
    try {
      value = JSON.parse(text) as typeof value;
    } catch {
      // Plain text.
    }
    const output = typeof value.output === "string" ? value.output : "";
    if (!response.ok)
      throw new SshJoinError(
        typeof value.message === "string" ? value.message : "Couldn't add the machine over SSH",
        output,
        value.reason === "ssh-running",
      );
    const parsed = await status(new Response(text, { status: 200 }), "Couldn't add the machine");
    return {
      ...parsed,
      joined: typeof value.joined === "string" ? value.joined : "",
      ...(typeof value.problem === "string" ? { problem: value.problem } : {}),
      output,
    };
  },
};

/** Why adding over SSH failed, and the end of what the session printed. */
export class SshJoinError extends MachinesError {
  readonly output: string;
  /** Refused because another install over SSH is running, which this one left alone. */
  readonly busy: boolean;
  constructor(message: string, output: string, busy = false) {
    super(message);
    this.output = output;
    this.busy = busy;
  }
}
