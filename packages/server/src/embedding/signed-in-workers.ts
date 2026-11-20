// Machines of a worker's own for a desktop Gram's orchestrators, from a hosted server the desktop
// app is signed in to (`docs/design/desktop-worker-machines.md`).
//
// Embedded, a Gram asks its embedder's host provider for a worker's machine
// (`worker-machines.ts`). A desktop Gram has no provider of its own and holds no token, but the
// desktop app may be signed in to a hosted server that starts worker machines for a desktop. So
// this server asks the app, over Electron's `parentPort`, and the app makes each call with the
// person's sign-in: the hosted server takes the person from the token, and this server names no
// owner.
//
// The machine can't dial this Gram: the desktop is usually behind NAT. Both sides dial the hosted
// server instead, which pairs them: the host dials it as its origin, and the app dials its relay
// for that machine. The app passes each relayed connection here as frames over the same port, and
// this Gram takes it as any dial, by the host's own signature over the hosted server's origin, once.
// This Gram registers the machine itself, from the key the server's status reports for the name it
// asked for, as a worker host that came through that server (`PairedMachine.via`): taken only from
// that server's relay, and the desktop's own, like a joined machine.

import { randomUUID } from "node:crypto";

import {
  HostId,
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
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { Socket } from "../platform/unstable.ts";
import { CHOICES_TTL_MS, type OnDemandChoices, parseChoices } from "./on-demand.ts";
import {
  askWorkerMachine,
  choicesOfAsk,
  type OfferedModel,
  parseOfferedModels,
  type ProvidedMachine,
  type WorkerMachineSource,
} from "./worker-machines.ts";

// ---------------------------------------------------------------------------------------------
// The door to the app.

type Refused = { readonly ok: false; readonly why: string; readonly signIn?: true };

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
  ) => Effect.Effect<
    { readonly ok: true; readonly status: number; readonly body: unknown } | Refused
  >;
  /** Asks the app to carry this machine's connection, dialling its relay again whenever it ends. */
  readonly relay: (origin: string, name: string) => void;
  readonly unrelay: (name: string) => void;
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

const NO_APP = "Worker machines from a hosted server are asked for only from the Gram desktop app.";
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
            return { ok: true as const, server: { origin: server.origin, server: server.server } };
          const why = "why" in result && typeof result.why === "string" ? result.why : undefined;
          return { ok: false as const, why: why ?? NO_SIGNED_IN_SERVER };
        }),
      ),
    call: (origin, call, body) =>
      ask({ op: "call", origin, call, body }).pipe(
        Effect.map((result) =>
          result.ok && "status" in result && typeof result.status === "number"
            ? { ok: true as const, status: result.status, body: result.body }
            : refusedOf(result),
        ),
      ),
    relay: (origin, name) =>
      post({ type: "machines.request", id: randomUUID(), op: "relay", origin, name }),
    unrelay: (name) => post({ type: "machines.request", id: randomUUID(), op: "unrelay", name }),
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

// ---------------------------------------------------------------------------------------------
// A provider of worker machines, as `spawn_worker`'s `sandbox` and the release pass use one.

/** Why `sandbox` is refused on a desktop with no signed-in server that starts worker machines. */
export const NO_SIGNED_IN_SERVER =
  "Sign in to a hosted server that offers worker machines (Settings → Machines → Hosted servers) for workers to have machines of their own.";

/** How long a desktop waits for a hosted machine to join before it stops it. */
export const ARRIVE_TIMEOUT_MS = 5 * 60_000;
const ARRIVE_EVERY_MS = 2_000;

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const PLATFORM = /^[a-z0-9]{1,16}$/;

/** A server's `…/status` answer as this reads it: its phase, a line, and the host's key once made. */
export const parseMachineStatus = (
  value: unknown,
): {
  readonly phase?: string;
  readonly message?: string;
  readonly publicKey?: string;
  readonly platform?: string;
} => {
  if (typeof value !== "object" || value === null) return {};
  const body = value as Record<string, unknown>;
  const line = (field: string, most: number) => {
    const each = body[field];
    return typeof each === "string" && each.length <= most && !/[\0\n\r]/.test(each)
      ? each
      : undefined;
  };
  const phase = line("phase", 24);
  const message = line("message", 300);
  const publicKey = line("publicKey", 64);
  const platform = line("platform", 16);
  return {
    ...(phase === undefined ? {} : { phase }),
    ...(message === undefined ? {} : { message }),
    ...(publicKey !== undefined && PUBLIC_KEY.test(publicKey) ? { publicKey } : {}),
    ...(platform !== undefined && PLATFORM.test(platform) ? { platform } : {}),
  };
};

/** What an orchestrator is told when the signed-in server's answer stops a machine joining. */
const failedWords = (name: string, why: string) => `The machine ${name} didn't join: ${why}`;

export interface SignedInDeps {
  readonly port: WorkerMachinePortShape;
  readonly hosts: Pick<RemoteHostsShape, "remove"> & {
    readonly list: () => ReadonlyArray<ProvidedMachine>;
    readonly machines: Pick<RemoteHostsShape["machines"], "provision">;
  };
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly everyMs?: number;
  /** What each server offered, kept across sources a short while; none kept when left out. */
  readonly offered?: OfferedByServer;
}

/** The choices and models each server offered, kept a short while, by origin. */
export type OfferedByServer = Map<
  string,
  {
    readonly at: number;
    readonly value?: OnDemandChoices;
    readonly models?: ReadonlyArray<OfferedModel>;
  }
>;

/** A hosted server the app is signed in to, as `sandbox`'s provider. */
export const signedInSource = (
  server: WorkerMachineServer,
  deps: SignedInDeps,
): WorkerMachineSource => {
  const { port, hosts } = deps;
  const now = deps.now ?? Date.now;
  const origin = server.origin;
  const offered: OfferedByServer = deps.offered ?? new Map();
  const mine = (machine: ProvidedMachine) =>
    machine.onDemand === "worker" && machine.via === origin && machine.owner === undefined;
  const named = (name: string) => hosts.list().find((each) => each.name === name && mine(each));
  /** One `…/choices` call, kept a short while: the picks it offers and the models it runs. */
  const asked = Effect.gen(function* () {
    const kept = offered.get(origin);
    if (kept !== undefined && now() - kept.at < CHOICES_TTL_MS) return kept;
    const answered = yield* port.call(origin, "choices", {});
    const body = answered.ok && answered.status === 200 ? answered.body : undefined;
    const value = parseChoices(body);
    const models = parseOfferedModels(body);
    const fresh = {
      at: now(),
      ...(value === undefined ? {} : { value }),
      ...(models === undefined ? {} : { models }),
    };
    offered.set(origin, fresh);
    return fresh;
  });
  const forget = (name: string) =>
    Effect.gen(function* () {
      port.unrelay(name);
      const machine = named(name);
      if (machine !== undefined) hosts.remove(HostId.make(machine.id));
      const stopped = yield* port.call(origin, "stop", { name });
      if (!stopped.ok || stopped.status >= 300)
        yield* Effect.logWarning("a worker machine given back could not be stopped").pipe(
          Effect.annotateLogs({
            machine: name,
            reason: stopped.ok ? `answered ${stopped.status}` : stopped.why,
          }),
        );
    });
  return {
    label: server.server,
    choices: Effect.map(asked, (kept) => kept.value),
    models: Effect.map(asked, (kept) => kept.models),
    abandon: forget,
    start: (ask) =>
      askWorkerMachine(
        ask,
        port
          .call(origin, "start", {
            name: ask.name,
            title: ask.title.slice(0, 120),
            orchestrator: ask.orchestrator,
            choices: choicesOfAsk(ask),
          })
          .pipe(
            Effect.map((answered) =>
              answered.ok
                ? { status: answered.status, body: answered.body }
                : { failed: answered.why },
            ),
          ),
      ).pipe(Effect.tap(() => Effect.sync(() => offered.delete(origin)))),
    theirs: mine,
    arrive: (name) =>
      Effect.gen(function* () {
        const deadline = now() + (deps.timeoutMs ?? ARRIVE_TIMEOUT_MS);
        let relayed = false;
        for (;;) {
          const machine = named(name);
          if (machine?.onlineSince !== undefined) return machine.id;
          if (machine === undefined) {
            const answered = yield* port.call(origin, "status", { name });
            if (!answered.ok) return { failed: failedWords(name, answered.why) };
            const status = parseMachineStatus(answered.body);
            if (answered.status === 404 || status.phase === "failed" || status.phase === "stopped")
              return {
                failed: failedWords(
                  name,
                  status.message ?? `${server.server} says it isn't starting.`,
                ),
              };
            if (status.publicKey !== undefined) {
              // Registered here by this Gram, for the name it asked for, from the server it asked.
              const result = hosts.machines.provision({
                name,
                publicKey: status.publicKey,
                platform: status.platform ?? "linux",
                onDemand: "worker",
                via: origin,
              });
              if (result.kind === "refused") return { failed: failedWords(name, result.message) };
            }
          }
          if (named(name) !== undefined && !relayed) {
            port.relay(origin, name);
            relayed = true;
          }
          if (now() >= deadline) return { failed: "timeout" };
          yield* Effect.sleep(deps.everyMs ?? ARRIVE_EVERY_MS);
        }
      }),
    timedOut: (name) =>
      Effect.as(
        forget(name),
        `The machine ${name} didn't join within ${Math.round((deps.timeoutMs ?? ARRIVE_TIMEOUT_MS) / 60_000)} minutes, so it was stopped. Spawn again to ask for a new one, or leave out sandbox to run the worker on your machine.`,
      ),
  };
};

/** Tells a signed-in server a worker machine's work is over, or going on again. */
export const tellSignedInRelease = (
  port: WorkerMachinePortShape,
  machine: { readonly name: string; readonly via: string },
  released: boolean,
) =>
  port
    .call(machine.via, "release", {
      name: machine.name,
      released,
      reason: released ? "finished" : "working",
    })
    .pipe(
      Effect.flatMap((answered) =>
        answered.ok && (answered.status < 300 || answered.status === 404)
          ? Effect.void
          : Effect.fail(
              new Error(answered.ok ? `the server answered ${answered.status}` : answered.why),
            ),
      ),
    );

/** The desktop's signed-in worker machines: the source for `sandbox`, and the relay it carries. */
export class SignedInWorkers extends Context.Service<
  SignedInWorkers,
  {
    readonly port: WorkerMachinePortShape;
    /** The signed-in server to ask now, as a source, or why there is none. */
    readonly source: Effect.Effect<
      | { readonly source: WorkerMachineSource; readonly server: WorkerMachineServer }
      | { readonly refused: string }
    >;
  }
>()("@gram/server/SignedInWorkers") {}

/** Takes one relayed connection as its machine's dial, or ends it with why. */
export const takeRelayedDial = (hosts: RemoteHostsShape, dial: RelayedDial) =>
  Effect.gen(function* () {
    const machine = hosts.machines.list().find((each) => each.name === dial.name);
    if (machine?.via === undefined || machine.via !== dial.origin) {
      dial.end(4401, "unauthorized: machine not joined");
      return;
    }
    const decision = hosts.machines.authorizeConnect(dial.origin, dial.headers, "relayed");
    if (decision.kind === "refused") {
      dial.end(4000 + decision.status, decision.message);
      return;
    }
    yield* hosts.attach(hosts.admit(decision.machine, dial.origin), yield* dial.socket);
  });

/**
 * Provides `SignedInWorkers` in the desktop app, where there are joined machines to register
 * worker hosts with; takes each relayed connection; and asks the app, once at start, to carry
 * every relayed worker host's connection again.
 */
export const SignedInWorkersLive = Layer.effect(
  SignedInWorkers,
  Effect.gen(function* () {
    const port = yield* WorkerMachinePort;
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    if (!port.available || hosts === undefined)
      return { port, source: Effect.succeed({ refused: NO_SIGNED_IN_SERVER } as const) };
    const offered: OfferedByServer = new Map();
    // Each relayed connection is served in this layer's scope, and ends with it.
    const dials = yield* Queue.unbounded<RelayedDial>();
    port.onDial((dial) => {
      Queue.offerUnsafe(dials, dial);
    });
    yield* Queue.take(dials).pipe(
      Effect.flatMap((dial) =>
        takeRelayedDial(hosts, dial).pipe(
          Effect.catchCause((cause) => Effect.logWarning("a relayed dial failed", cause)),
          Effect.forkScoped,
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    for (const machine of hosts.list())
      if (machine.via !== undefined && machine.onDemand === "worker")
        port.relay(machine.via, machine.name);
    return {
      port,
      source: port.server().pipe(
        Effect.map((answered) =>
          answered.ok
            ? {
                source: signedInSource(answered.server, { port, hosts, offered }),
                server: answered.server,
              }
            : {
                refused:
                  answered.why === NO_APP || answered.why === NO_SIGNED_IN_SERVER
                    ? NO_SIGNED_IN_SERVER
                    : `${answered.why} ${NO_SIGNED_IN_SERVER}`,
              },
        ),
      ),
    };
  }),
);
