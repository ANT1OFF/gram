import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
export const record = (value: unknown): Record<string, unknown> => object.parse(value);
export const modelState = z.object({
  currentModelId: z.string(),
  availableModels: z.array(
    z.object({ modelId: z.string(), name: z.string(), description: z.string().optional() }),
  ),
});
export const initialization = z.object({
  protocolVersion: z.literal(1),
  authMethods: z.array(z.object({ id: z.string() })),
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    mcpCapabilities: z.object({ http: z.boolean().optional() }).optional(),
  }),
  _meta: z.object({ agentVersion: z.string(), modelState }).passthrough(),
});

/** Only the official Grok ACP dialect, never a generic ACP executable registry. */
export function grokRpc(child: ChildProcess, receive: (message: Record<string, unknown>) => void) {
  let sequence = 0;
  let dead = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const send = (message: unknown) => {
    if (dead || child.stdin?.writable !== true)
      throw new Error("Grok Build process is unavailable");
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const fail = () => {
    if (dead) return;
    dead = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Grok Build connection ended"));
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    try {
      if (line.length > 8 * 1024 * 1024) throw new Error("Oversized Grok frame");
      const message = record(JSON.parse(line));
      if (message.jsonrpc !== "2.0") throw new Error("Invalid Grok frame");
      if (typeof message.method === "string") receive(message);
      else if (typeof message.id === "number") {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        // Provider error data can contain credentials, URLs or prompts. Never forward it.
        if (message.error !== undefined)
          request.reject(new Error("Grok Build rejected the protocol request"));
        else request.resolve(message.result);
      }
    } catch {
      fail();
      child.stdin?.end();
    }
  });
  child.once("error", fail);
  child.once("exit", fail);
  child.stdout?.once("end", fail);
  // Drain without logging provider stderr (it may contain account information).
  child.stderr?.resume();
  return {
    request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (dead) return reject(new Error("Grok Build connection ended"));
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Grok Build ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ jsonrpc: "2.0", id, method, params });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("Grok Build write failed"));
        }
      });
    },
    notify(method: string, params: unknown) {
      send({ jsonrpc: "2.0", method, params });
    },
    reply(id: unknown, result: unknown) {
      send({ jsonrpc: "2.0", id, result });
    },
    refuse(id: unknown) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Gram does not support this client capability" },
      });
    },
    close() {
      fail();
      lines.close();
    },
  };
}
