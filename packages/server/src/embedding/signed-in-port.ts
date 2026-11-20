// The door to the desktop app for `signed-in-workers.ts`: each call to a hosted server's worker
// machines, asked of the app over Electron's `parentPort` and answered by id, and each connection
// the app relays from a machine's host, as a socket here.

import { randomUUID } from "node:crypto";

import {
  WORKER_MACHINE_NAME,
  type WorkerMachineCall,
  type WorkerMachineOp,
  type WorkerMachineRelayMessage,
  type WorkerMachineRequestMessage,
  type WorkerMachineResponseMessage,
  type WorkerMachineResult,
  type WorkerMachineServer,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Socket } from "../platform/unstable.ts";

/** Why `sandbox` is refused on a desktop with no signed-in server that starts worker machines. */
export const NO_SIGNED_IN_SERVER =
  "Sign in to a hosted server that offers worker machines (Settings → Machines → Hosted servers) for workers to have machines of their own.";

export type Refused = { readonly ok: false; readonly why: string; readonly signIn?: true };

export interface WorkerMachinePortShape {
  /** Whether there is an app to ask at all. */
  readonly available: boolean;
  /** The server worker machines may be asked of now, or why none. */
  readonly server: () => Effect.Effect<
    { readonly ok: true; readonly server: WorkerMachineServer } | Refused
  >;
  /** One call to it, answered with its status and JSON body as received. */
  readonly call: (
    origin: string,
    call: WorkerMachineCall,
    body: Readonly<Record<string, unknown>>,
    /** The latest time the app may send it (`WorkerMachineOp`'s `sendBy`). */
    options?: { readonly sendBy?: number; readonly account?: string | undefined },
  ) => Effect.Effect<
    { readonly ok: true; readonly status: number; readonly body: unknown } | Refused
  >;
  /**
   * Asks the app to carry this machine's connection, dialling its relay again whenever it ends:
   * under the sign-in `account` alone, where one is given.
   */
  readonly relay: (origin: string, name: string, account?: string) => void;
  readonly unrelay: (name: string) => void;
  /**
   * Tells the app to carry exactly these and no others; `fresh` from a server just started, so
   * every connection the app carried for the one before is dialled again.
   */
  readonly relays: (
    machines: ReadonlyArray<{
      readonly origin: string;
      readonly name: string;
      readonly account?: string;
    }>,
    fresh?: boolean,
  ) => void;
  /** Where each relayed connection the app opens is handed: one handler, the latest set. */
  readonly onDial: (handler: (dial: RelayedDial) => void) => void;
}

/** A connection the app relays from a host, as a socket here, with the headers the host signed. */
export interface RelayedDial {
  readonly origin: string;
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly socket: Effect.Effect<Socket.Socket>;
  /** Ends it from this side, with a WebSocket close code and a few words for the host's log. */
  readonly end: (code: number, reason: string) => void;
}

/** Electron's `process.parentPort` as the server sees it. */
export interface WorkerMachineMessagePort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
}

export const NO_APP =
  "Worker machines from a hosted server are asked for only from the Gram desktop app.";
const NO_ANSWER = "The desktop app didn't answer.";

const isResponse = (message: unknown): message is WorkerMachineResponseMessage =>
  typeof message === "object" &&
  message !== null &&
  Reflect.get(message, "type") === "machines.response" &&
  typeof Reflect.get(message, "id") === "string" &&
  typeof Reflect.get(message, "result") === "object" &&
  Reflect.get(message, "result") !== null;

const CONN = /^[A-Za-z0-9_-]{8,64}$/;
const HEADER = /^x-gram-host-[a-z]{2,16}$/;

/** A relay message from the app, read field by field; anything else is no relay message. */
const relayMessageOf = (message: unknown): WorkerMachineRelayMessage | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const type = Reflect.get(message, "type");
  const conn = Reflect.get(message, "conn");
  if (typeof conn !== "string" || !CONN.test(conn)) return undefined;
  if (type === "machines.relay.frame") {
    const data = Reflect.get(message, "data");
    return typeof data === "string" || data instanceof Uint8Array
      ? { type, conn, data }
      : undefined;
  }
  if (type === "machines.relay.end") return { type, conn };
  if (type !== "machines.relay.dial") return undefined;
  const origin = Reflect.get(message, "origin");
  const name = Reflect.get(message, "name");
  const headers = Reflect.get(message, "headers");
  if (
    typeof origin !== "string" ||
    origin.length > 512 ||
    typeof name !== "string" ||
    !WORKER_MACHINE_NAME.test(name) ||
    typeof headers !== "object" ||
    headers === null
  )
    return undefined;
  const entries = Object.entries(headers as Record<string, unknown>);
  if (
    entries.length > 8 ||
    !entries.every(
      ([key, value]) => HEADER.test(key) && typeof value === "string" && value.length <= 512,
    )
  )
    return undefined;
  return {
    type,
    conn,
    origin,
    name,
    headers: Object.fromEntries(entries) as Record<string, string>,
  };
};

const OPEN = 1;
const CLOSED = 3;

/**
 * One relayed connection as a WebSocket the socket layer reads: frames from the app are its
 * messages, and what is sent on it goes back to the app as frames for the host.
 */
const portWebSocket = (conn: string, post: (message: WorkerMachineRelayMessage) => void) => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let readyState = OPEN;
  const emit = (type: string, event: unknown) => {
    // A copy, so a listener added or removed as one runs changes nothing until the next event.
    for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
  };
  const closed = (code: number, reason: string) => {
    if (readyState === CLOSED) return;
    readyState = CLOSED;
    emit("close", { code, reason });
  };
  const ws = {
    get readyState() {
      return readyState;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      let set = listeners.get(type);
      if (set === undefined) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    send(data: string | Uint8Array) {
      if (readyState !== OPEN) return;
      post({ type: "machines.relay.frame", conn, data });
    },
    close(code?: number, reason?: string) {
      if (readyState === CLOSED) return;
      post({
        type: "machines.relay.end",
        conn,
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 120) }),
      });
      closed(code ?? 1000, reason ?? "");
    },
  };
  return {
    ws,
    deliver: (data: string | Uint8Array) => {
      if (readyState === OPEN) emit("message", { data });
    },
    ended: () => closed(1006, "the relay ended"),
  };
};

const refusedOf = (result: WorkerMachineResult): Refused =>
  result.ok ? { ok: false, why: "The desktop app's answer isn't one the server reads." } : result;

/** Requests over `port`, each answered by id or failed after its time, and relayed connections. */
export const bridgeWorkerMachines = (
  port: WorkerMachineMessagePort,
  timeoutMs: (op: WorkerMachineOp) => number = (op) => (op.op === "call" ? 45_000 : 15_000),
): WorkerMachinePortShape => {
  const pending = new Map<string, (result: WorkerMachineResult) => void>();
  const conns = new Map<string, ReturnType<typeof portWebSocket>>();
  let handler: ((dial: RelayedDial) => void) | undefined;
  const post = (message: unknown) => port.postMessage(message);
  port.on("message", ({ data }) => {
    if (isResponse(data)) {
      pending.get(data.id)?.(data.result);
      return;
    }
    const relayed = relayMessageOf(data);
    if (relayed === undefined) return;
    if (relayed.type === "machines.relay.frame") conns.get(relayed.conn)?.deliver(relayed.data);
    else if (relayed.type === "machines.relay.end") {
      conns.get(relayed.conn)?.ended();
      conns.delete(relayed.conn);
    } else {
      if (conns.has(relayed.conn) || handler === undefined) {
        post({ type: "machines.relay.end", conn: relayed.conn, code: 4503, reason: "not taken" });
        return;
      }
      const made = portWebSocket(relayed.conn, (message) => {
        if (message.type === "machines.relay.end") conns.delete(relayed.conn);
        post(message);
      });
      conns.set(relayed.conn, made);
      handler({
        origin: relayed.origin,
        name: relayed.name,
        headers: relayed.headers,
        socket: Socket.fromWebSocket(Effect.succeed(made.ws as unknown as Socket.WebSocketLike)),
        end: (code, reason) => made.ws.close(code, reason),
      });
    }
  });
  const ask = (op: WorkerMachineOp): Effect.Effect<WorkerMachineResult> =>
    Effect.callback<WorkerMachineResult>((resume) => {
      const id = randomUUID();
      const timer = setTimeout(() => settle({ ok: false, why: NO_ANSWER }), timeoutMs(op));
      function settle(result: WorkerMachineResult) {
        clearTimeout(timer);
        pending.delete(id);
        resume(Effect.succeed(result));
      }
      pending.set(id, settle);
      const message: WorkerMachineRequestMessage = { type: "machines.request", id, ...op };
      post(message);
      return Effect.sync(() => {
        clearTimeout(timer);
        pending.delete(id);
      });
    });
  return {
    available: true,
    server: () =>
      ask({ op: "server" }).pipe(
        Effect.map((result) => {
          if (!result.ok) return result;
          const server = "server" in result ? result.server : undefined;
          if (
            typeof server === "object" &&
            server !== null &&
            typeof server.origin === "string" &&
            typeof server.server === "string"
          )
            return {
              ok: true as const,
              server: {
                origin: server.origin,
                server: server.server,
                ...(typeof server.account === "string" && server.account.length <= 64
                  ? { account: server.account }
                  : {}),
                ...(Array.isArray(server.formerAccounts) &&
                server.formerAccounts.length <= 8 &&
                server.formerAccounts.every(
                  (each: unknown) => typeof each === "string" && each.length <= 64,
                )
                  ? { formerAccounts: server.formerAccounts as ReadonlyArray<string> }
                  : {}),
              },
            };
          const why = "why" in result && typeof result.why === "string" ? result.why : undefined;
          return { ok: false as const, why: why ?? NO_SIGNED_IN_SERVER };
        }),
      ),
    call: (origin, call, body, options) =>
      ask({
        op: "call",
        origin,
        call,
        body,
        ...(options?.sendBy === undefined ? {} : { sendBy: options.sendBy }),
        ...(options?.account === undefined ? {} : { account: options.account }),
      }).pipe(
        Effect.map((result) =>
          result.ok && "status" in result && typeof result.status === "number"
            ? { ok: true as const, status: result.status, body: result.body }
            : refusedOf(result),
        ),
      ),
    relay: (origin, name, account) =>
      post({
        type: "machines.request",
        id: randomUUID(),
        op: "relay",
        origin,
        name,
        ...(account === undefined ? {} : { account }),
      }),
    unrelay: (name) => post({ type: "machines.request", id: randomUUID(), op: "unrelay", name }),
    relays: (machines, fresh) =>
      post({
        type: "machines.request",
        id: randomUUID(),
        op: "relays",
        machines,
        ...(fresh === true ? { fresh: true } : {}),
      }),
    onDial: (next) => {
      handler = next;
    },
  };
};

const refusedHere = Effect.succeed({ ok: false as const, why: NO_APP });

/** No desktop app: no server to ask. */
export const NO_WORKER_MACHINES: WorkerMachinePortShape = {
  available: false,
  server: () => refusedHere,
  call: () => refusedHere,
  relay: () => undefined,
  unrelay: () => undefined,
  relays: () => undefined,
  onDial: () => undefined,
};

export class WorkerMachinePort extends Context.Service<WorkerMachinePort, WorkerMachinePortShape>()(
  "@gram/server/WorkerMachinePort",
) {
  /** The desktop app when Electron supplied a parent port; otherwise none. */
  static readonly layer: Layer.Layer<WorkerMachinePort> = Layer.sync(WorkerMachinePort, () => {
    const port = (process as { parentPort?: WorkerMachineMessagePort }).parentPort;
    return port === undefined ? NO_WORKER_MACHINES : bridgeWorkerMachines(port);
  });
}
