import type { ChildProcess } from "node:child_process";

import { spawnServe, stopChild } from "../child-process.ts";

/** A JSON-RPC error an ACP agent answered with. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

/** What the agent sends that isn't an answer: a notification, or a request the client answers. */
export interface AcpHandlers {
  readonly notification: (method: string, params: Readonly<Record<string, unknown>>) => void;
  /** Resolves with the result, or rejects with an `AcpError` to answer with an error. */
  readonly request: (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** One ACP agent process over stdio, newline-delimited JSON-RPC 2.0 both ways. */
export interface AcpConnection {
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Settles with why the process ended, once it has. */
  readonly ended: Promise<string>;
  readonly pid: number | undefined;
  stop(): Promise<void>;
}

const STDERR_TAIL = 2_000;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Wires JSON-RPC over an already started child's stdio. */
export const connectAcp = (child: ChildProcess, handlers: AcpHandlers): AcpConnection => {
  let next = 0;
  const waiting = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let stderr = "";
  let gone: string | undefined;
  const write = (message: Record<string, unknown>) => {
    if (gone !== undefined || child.stdin === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const onMessage = (message: Readonly<Record<string, unknown>>) => {
    const method = message["method"];
    const id = message["id"];
    if (typeof method === "string") {
      const params = record(message["params"]);
      if (id === undefined || id === null) {
        handlers.notification(method, params);
        return;
      }
      void handlers.request(method, params).then(
        (result) => write({ id, result: result ?? null }),
        (error: unknown) =>
          write({
            id,
            error:
              error instanceof AcpError
                ? { code: error.code, message: error.message }
                : { code: -32603, message: error instanceof Error ? error.message : String(error) },
          }),
      );
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") return;
    const pending = waiting.get(id);
    if (pending === undefined) return;
    waiting.delete(id);
    const error = message["error"];
    if (error !== undefined && error !== null) {
      const body = record(error);
      pending.reject(
        new AcpError(
          typeof body["code"] === "number" ? body["code"] : -32603,
          typeof body["message"] === "string" ? body["message"] : "The agent refused the request",
          body["data"],
        ),
      );
    } else pending.resolve(message["result"]);
  };

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    buffer += data;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(record(parsed));
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    stderr = (stderr + data).slice(-STDERR_TAIL);
  });

  const ended = new Promise<string>((resolve) => {
    const finish = (reason: string) => {
      if (gone !== undefined) return;
      gone = reason;
      for (const pending of waiting.values()) pending.reject(new AcpError(-32000, reason));
      waiting.clear();
      resolve(reason);
    };
    child.once("error", (error) => finish(`The agent didn't start: ${error.message}`));
    child.once("exit", (code, signal) => {
      const tail = stderr.trim().split("\n").at(-1)?.trim();
      finish(
        `The agent exited (${signal ?? `code ${code}`})${tail === undefined || tail === "" ? "" : `: ${tail}`}`,
      );
    });
  });

  return {
    request: <T>(method: string, params: Record<string, unknown>) =>
      new Promise<T>((resolve, reject) => {
        if (gone !== undefined) return reject(new AcpError(-32000, gone));
        const id = ++next;
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
        write({ id, method, params });
      }),
    notify: (method, params) => write({ method, params }),
    ended,
    pid: child.pid,
    stop: () => stopChild(child),
  };
};

export interface StartAcpAgent {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly handlers: AcpHandlers;
}

/** Starts an ACP agent and connects to it. */
export const startAcpAgent = (input: StartAcpAgent): AcpConnection =>
  connectAcp(
    spawnServe(input.binary, input.args, input.env, { stdin: "pipe", cwd: input.cwd }),
    input.handlers,
  );
