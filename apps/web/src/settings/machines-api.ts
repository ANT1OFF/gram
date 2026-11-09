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
}

export interface MachinesStatus {
  readonly machines: ReadonlyArray<JoinedMachine>;
  /** A join link waiting to be used. */
  readonly joinLink?: { readonly expiresAt: number };
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
    (m["onlineSince"] === undefined || typeof m["onlineSince"] === "number")
  );
};

const status = async (response: Response, fallback: string): Promise<MachinesStatus> => {
  if (!response.ok) throw await refusal(response, fallback);
  const value = (await response.json()) as { machines?: unknown; joinLink?: unknown };
  if (!Array.isArray(value.machines) || !value.machines.every(isMachine))
    throw new MachinesError(fallback);
  const link = value.joinLink as { expiresAt?: unknown } | undefined;
  return {
    machines: value.machines,
    ...(typeof link?.expiresAt === "number" ? { joinLink: { expiresAt: link.expiresAt } } : {}),
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
  joinLink: async (): Promise<JoinLink | "tailscale-off"> => {
    const response = await post("/machines/join-link");
    if (response.status === 409) return "tailscale-off";
    if (!response.ok) throw await refusal(response, "Couldn't make a join link");
    const value = (await response.json()) as { url?: unknown; expiresAt?: unknown };
    if (typeof value.url !== "string" || typeof value.expiresAt !== "number")
      throw new MachinesError("Couldn't make a join link");
    return { url: value.url, expiresAt: value.expiresAt };
  },
};
