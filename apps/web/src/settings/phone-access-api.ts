import { RemoteAccessStatus } from "@gram/contracts";
import * as Schema from "effect/Schema";

/**
 * Phone access is managed over plain same-origin POSTs that the server's auth layer answers
 * itself, never over RPC: a paired phone holds an RPC socket too, and must not be able to turn
 * access on or off, mint links or remove other browsers.
 */
export class PhoneAccessError extends Error {}

const decodeStatus = Schema.decodeUnknownSync(RemoteAccessStatus);

const post = async (path: string, body?: unknown): Promise<Response> =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

/** The server's own words for a refusal, when it sent JSON `{ message }` or plain text. */
const refusal = async (response: Response, fallback: string): Promise<PhoneAccessError> => {
  const text = await response.text().catch(() => "");
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && "message" in value)
      return new PhoneAccessError(String(value.message));
  } catch {
    // Plain text.
  }
  return new PhoneAccessError(text.trim() !== "" && text.length < 200 ? text : fallback);
};

const status = async (response: Response, fallback: string): Promise<RemoteAccessStatus> => {
  if (!response.ok) throw await refusal(response, fallback);
  return decodeStatus(await response.json());
};

export const phoneAccess = {
  status: async () => status(await post("/remote/status"), "Couldn't read phone access"),
  enable: async (port?: number) =>
    status(
      await post("/remote/enable", port === undefined ? {} : { port }),
      "Couldn't turn on phone access",
    ),
  disable: async () => status(await post("/remote/disable"), "Couldn't turn off phone access"),
  revoke: async (target: { readonly id: string } | { readonly all: true }) =>
    status(await post("/remote/revoke", target), "Couldn't remove the browser"),
  /** A one-time link, or `full` when eight browsers are paired already. */
  pair: async (): Promise<{ url: string; expiresAt: number } | "full"> => {
    const response = await post("/remote/pair");
    if (response.status === 409) return "full";
    if (!response.ok) throw await refusal(response, "Couldn't make a pairing link");
    const value = (await response.json()) as { url?: unknown; expiresAt?: unknown };
    if (typeof value.url !== "string" || typeof value.expiresAt !== "number")
      throw new PhoneAccessError("Couldn't make a pairing link");
    return { url: value.url, expiresAt: value.expiresAt };
  },
};
