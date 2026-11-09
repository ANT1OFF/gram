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
  /** When this Gram sent it a Claude token from `claude setup-token`; a time, never the token. */
  readonly claudeTokenSetAt?: number;
}

export interface MachinesStatus {
  readonly machines: ReadonlyArray<JoinedMachine>;
  /** A join link waiting to be used. */
  readonly joinLink?: { readonly expiresAt: number };
  /** After a Remove: the machine was offline, so the Claude token sent to it is still there. */
  readonly tokenLeft?: true;
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
    (m["claudeTokenSetAt"] === undefined || typeof m["claudeTokenSetAt"] === "number")
  );
};

const status = async (response: Response, fallback: string): Promise<MachinesStatus> => {
  if (!response.ok) throw await refusal(response, fallback);
  const value = (await response.json()) as {
    machines?: unknown;
    joinLink?: unknown;
    tokenLeft?: unknown;
  };
  if (!Array.isArray(value.machines) || !value.machines.every(isMachine))
    throw new MachinesError(fallback);
  const link = value.joinLink as { expiresAt?: unknown } | undefined;
  return {
    machines: value.machines,
    ...(typeof link?.expiresAt === "number" ? { joinLink: { expiresAt: link.expiresAt } } : {}),
    ...(value.tokenLeft === true ? { tokenLeft: true } : {}),
  };
};

/**
 * What a start carries to show the person agreed to the consent dialog; the server refuses a start
 * without it.
 */
export const TOKEN_CONSENT = "send-claude-token-to-these-machines";

/** One machine's answer once the token was sent. */
export interface TokenSent {
  readonly id: string;
  readonly ok: boolean;
  readonly message?: string;
}

/** A `claude setup-token` run, as the server reports it; its output never reaches the page. */
export type TokenRun =
  | { readonly state: "waiting"; readonly signInLink?: string; readonly asksForCode: boolean }
  | { readonly state: "sending" }
  | { readonly state: "done"; readonly results: ReadonlyArray<TokenSent> }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "cancelled" };

const isTokenRun = (value: unknown): value is TokenRun => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Record<string, unknown>;
  switch (run["state"]) {
    case "waiting":
      return (
        typeof run["asksForCode"] === "boolean" &&
        (run["signInLink"] === undefined ||
          (typeof run["signInLink"] === "string" && run["signInLink"].startsWith("https://")))
      );
    case "sending":
    case "cancelled":
      return true;
    case "failed":
      return typeof run["message"] === "string";
    case "done":
      return (
        Array.isArray(run["results"]) &&
        run["results"].every(
          (result: unknown) =>
            typeof result === "object" &&
            result !== null &&
            typeof (result as TokenSent).id === "string" &&
            typeof (result as TokenSent).ok === "boolean",
        )
      );
    default:
      return false;
  }
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
   * The Claude token from `claude setup-token` on this machine, for joined machines the person
   * consented to send it to. Only the run's state comes back: never its output or the token.
   */
  claudeToken: {
    start: async (ids: ReadonlyArray<string>): Promise<string> => {
      const response = await post("/machines/claude-token/start", {
        ids,
        consent: TOKEN_CONSENT,
      });
      if (!response.ok) throw await refusal(response, "Couldn't start claude setup-token");
      const value = (await response.json()) as { captureId?: unknown };
      if (typeof value.captureId !== "string")
        throw new MachinesError("Couldn't start claude setup-token");
      return value.captureId;
    },
    status: async (captureId: string): Promise<TokenRun> => {
      const response = await post("/machines/claude-token/status", { captureId });
      if (!response.ok) throw await refusal(response, "Couldn't read the sign-in");
      const value: unknown = await response.json();
      if (!isTokenRun(value)) throw new MachinesError("Couldn't read the sign-in");
      return value;
    },
    code: async (captureId: string, code: string): Promise<void> => {
      const response = await post("/machines/claude-token/code", { captureId, code });
      if (!response.ok) throw await refusal(response, "Couldn't send the code");
    },
    cancel: async (captureId: string): Promise<void> => {
      await post("/machines/claude-token/cancel", { captureId });
    },
    forget: async (id: string) =>
      status(await post("/machines/claude-token/forget", { id }), "Couldn't forget the token"),
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
