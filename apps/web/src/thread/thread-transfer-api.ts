import { serverUrl } from "@/api/server-base";

/**
 * A thread out of this server as a bundle (`POST /threads/export`), and the read-only copy it
 * leaves once the other side has it (`POST /threads/settle`). Plain same-origin POSTs the local
 * app alone may make, never RPC: a paired phone holds an RPC socket too.
 */
export class ThreadTransferError extends Error {}

const post = async (path: string, body: unknown, fallback: string): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(serverUrl(path), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ThreadTransferError(fallback);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (response.ok) return value;
  const said =
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
      ? value.error
      : undefined;
  throw new ThreadTransferError(said ?? fallback);
};

/** The thread's bundle, as the server wrote it; read only for what the dialog shows. */
export interface ExportedThread {
  readonly bundle: unknown;
  readonly exportedAt: number;
  readonly notes: readonly string[];
}

export const exportThread = async (threadId: string): Promise<ExportedThread> => {
  const bundle = await post("/threads/export", { threadId }, "The thread couldn't be exported.");
  const fields = (typeof bundle === "object" && bundle !== null ? bundle : {}) as {
    exportedAt?: unknown;
    notes?: unknown;
  };
  if (typeof fields.exportedAt !== "number")
    throw new ThreadTransferError("The thread couldn't be exported.");
  return {
    bundle,
    exportedAt: fields.exportedAt,
    notes: Array.isArray(fields.notes)
      ? fields.notes.filter((note): note is string => typeof note === "string")
      : [],
  };
};

export const settleThread = async (input: {
  readonly threadId: string;
  readonly exportedAt: number;
  readonly to: string;
  readonly url?: string;
}): Promise<void> => {
  await post("/threads/settle", input, "The copy here couldn't be made read-only.");
};
