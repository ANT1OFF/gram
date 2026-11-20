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
  hostServes,
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
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import { ServerConfig } from "../config.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { noAppToolsTunnel } from "../host/app-tools-tunnel.ts";
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
  /**
   * Tells the app to carry exactly these and no others; `fresh` from a server just started, so
   * every connection the app carried for the one before is dialled again.
   */
  readonly relays: (
    machines: ReadonlyArray<{ readonly origin: string; readonly name: string }>,
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

// ---------------------------------------------------------------------------------------------
// A provider of worker machines, as `spawn_worker`'s `sandbox` and the release pass use one.

/** Why `sandbox` is refused on a desktop with no signed-in server that starts worker machines. */
export const NO_SIGNED_IN_SERVER =
  "Sign in to a hosted server that offers worker machines (Settings → Machines → Hosted servers) for workers to have machines of their own.";

/** The most machines from hosted servers this Gram registers at once (and the app relays). */
export const RELAYED_MOST = 32;

/** How many times a machine given back is asked to stop, and the wait between. */
const STOP_ATTEMPTS = 3;
const STOP_RETRY_MS = 2_000;

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

/**
 * A server's name as an orchestrator reads it, in its prompt and its tools' words: one line of
 * printable text, at most 60 characters, so a name can't pass for instructions.
 */
export const plainName = (name: string): string => {
  const flat = [...name]
    .map((char) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...flat].slice(0, 60).join("");
  return cut === "" ? "The hosted server" : cut;
};

/** What an orchestrator is told when the signed-in server's answer stops a machine joining. */
const failedWords = (name: string, why: string) => `The machine ${name} didn't join: ${why}`;

export interface SignedInDeps {
  readonly port: WorkerMachinePortShape;
  readonly hosts: Pick<RemoteHostsShape, "remove"> & {
    readonly list: () => ReadonlyArray<ProvidedMachine>;
    /** Its host's hello once online, to refuse one that can't carry app tools; absent in fakes. */
    readonly connection?: RemoteHostsShape["connection"];
    readonly machines: Pick<RemoteHostsShape["machines"], "provision">;
  };
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly everyMs?: number;
  readonly stopRetryMs?: number;
  /** What each server offered, kept across sources a short while; none kept when left out. */
  readonly offered?: OfferedByServer;
  /** Stops a server never confirmed, for machines not registered here, to ask again later. */
  readonly owed?: OwedStops;
  /** The names a start is on its way for, which no stop owed for an earlier one may end. */
  readonly starting?: Set<string>;
}

/**
 * How long after a start whose outcome wasn't known (no answer, or one interrupted on its way) the
 * server's "no such machine" is taken as the end of it: a start still on its way may make the
 * machine after a stop that came first, so until then a 404 settles nothing.
 */
export const UNSETTLED_START_MS = 15 * 60_000;

/** A stop a server never confirmed. `unsettled`: its start's outcome wasn't known when it was owed. */
export interface OwedStop {
  readonly origin: string;
  readonly name: string;
  readonly since: number;
  readonly unsettled?: true;
}

/**
 * The machines a server was asked to stop and never confirmed, with nothing registered here for the
 * release pass to tell it of: asked again every `RECLAIMED_EVERY` until one is, and kept across a
 * restart (`fileOwedStops`).
 */
export interface OwedStops {
  readonly list: () => ReadonlyArray<OwedStop>;
  readonly add: (stop: OwedStop) => void;
  readonly remove: (name: string) => void;
}

export const memoryOwedStops = (): OwedStops => {
  const owed = new Map<string, OwedStop>();
  return {
    list: () => [...owed.values()],
    add: (stop) => void owed.set(stop.name, stop),
    remove: (name) => void owed.delete(name),
  };
};

/** `memoryOwedStops` kept in `<dataDir>/remote-access/worker-machine-stops.json`. */
export const fileOwedStops = (dataDir: string): OwedStops => {
  const file = privateJsonFile(dataDir, "worker-machine-stops.json", 64 * 1024);
  const owed = memoryOwedStops();
  try {
    const kept = file.read() as { version?: unknown; owed?: unknown } | undefined;
    if (kept?.version === 1 && Array.isArray(kept.owed))
      for (const each of kept.owed.slice(0, 256))
        if (
          typeof each === "object" &&
          each !== null &&
          typeof each.origin === "string" &&
          typeof each.name === "string" &&
          WORKER_MACHINE_NAME.test(each.name) &&
          Number.isSafeInteger(each.since)
        )
          owed.add({
            origin: each.origin,
            name: each.name,
            since: each.since,
            ...(each.unsettled === true ? { unsettled: true as const } : {}),
          });
  } catch {
    // An unreadable file owes nothing; the next stop owed writes it again.
  }
  const save = () => {
    try {
      file.write({ version: 1, owed: owed.list() });
    } catch {
      // Kept in memory for this run.
    }
  };
  return {
    list: owed.list,
    add: (stop) => {
      owed.add(stop);
      save();
    },
    remove: (name) => {
      if (!owed.list().some((each) => each.name === name)) return;
      owed.remove(name);
      save();
    },
  };
};

/**
 * Asks again for each stop owed; one confirmed is let go, as is one the server knows no more once
 * no start of it can still be on its way. A name this Gram is starting again, or has registered
 * since, is the new start's: that machine is no longer owed a stop (the release pass looks after a
 * registered one), so a debt never stops a retry that took its name.
 */
export const settleOwedStops = (
  port: WorkerMachinePortShape,
  owed: OwedStops,
  claimed: (name: string) => boolean = () => false,
  now: () => number = Date.now,
) =>
  Effect.gen(function* () {
    for (const stop of owed.list()) {
      if (claimed(stop.name)) {
        owed.remove(stop.name);
        continue;
      }
      const answered = yield* port.call(stop.origin, "stop", { name: stop.name });
      if (!answered.ok) continue;
      if (answered.status < 300) owed.remove(stop.name);
      else if (
        answered.status === 404 &&
        (stop.unsettled !== true || now() - stop.since >= UNSETTLED_START_MS)
      )
        owed.remove(stop.name);
    }
  });

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
  /**
   * Stops a machine there, a few times if need be, and forgets it here once it is stopped (or the
   * server knows it no more). One that couldn't be stopped stays registered here, so the release
   * pass still tells the server its work is over, and the server reclaims it as it does an idle
   * one. Whether it was stopped.
   */
  const forget = (name: string, unsettled = false) =>
    Effect.gen(function* () {
      deps.starting?.delete(name);
      let stopped = false;
      let last = "";
      for (let attempt = 0; attempt < STOP_ATTEMPTS && !stopped; attempt += 1) {
        if (attempt > 0) yield* Effect.sleep(deps.stopRetryMs ?? STOP_RETRY_MS);
        const answered = yield* port.call(origin, "stop", { name });
        // "No such machine" ends nothing while a start of it may still be on its way.
        stopped = answered.ok && (answered.status < 300 || (answered.status === 404 && !unsettled));
        // Only the status: what a server answers isn't written to the log.
        last = answered.ok ? `answered ${answered.status}` : "no answer";
      }
      if (!stopped) {
        yield* Effect.logWarning("a worker machine given back could not be stopped").pipe(
          Effect.annotateLogs({ machine: name, reason: last }),
        );
        // Registered here, the release pass tells the server; otherwise it is owed a stop.
        if (named(name) === undefined)
          deps.owed?.add({
            origin,
            name,
            since: now(),
            ...(unsettled ? { unsettled: true as const } : {}),
          });
        return false;
      }
      deps.owed?.remove(name);
      port.unrelay(name);
      const machine = named(name);
      if (machine !== undefined) hosts.remove(HostId.make(machine.id));
      return true;
    });
  return {
    label: plainName(server.server),
    choices: Effect.map(asked, (kept) => kept.value),
    models: Effect.map(asked, (kept) => kept.models),
    givesBack: true,
    abandon: (name, options) => Effect.asVoid(forget(name, options?.unsettled === true)),
    start: (ask) =>
      Effect.suspend(() => {
        // This start takes the name: no stop owed for an earlier one may end the machine it makes.
        deps.starting?.add(ask.name);
        deps.owed?.remove(ask.name);
        return askWorkerMachine(
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
        ).pipe(
          Effect.tap((started) =>
            Effect.sync(() => {
              offered.delete(origin);
              // A clear refusal made nothing; one with no answer is the spawn's to give back.
              if (
                started.kind !== "started" &&
                started.kind === "refused" &&
                started.unknown !== true
              )
                deps.starting?.delete(ask.name);
              if (started.kind === "over-total") deps.starting?.delete(ask.name);
            }),
          ),
        );
      }),
    theirs: mine,
    arrive: (name) =>
      Effect.gen(function* () {
        const deadline = now() + (deps.timeoutMs ?? ARRIVE_TIMEOUT_MS);
        let relayed = false;
        for (;;) {
          const machine = named(name);
          if (machine?.onlineSince !== undefined) {
            // One whose gram-host can't carry app tools runs no session: refused now, not later.
            const connected =
              hosts.connection === undefined
                ? undefined
                : yield* hosts.connection(HostId.make(machine.id)).pipe(Effect.option);
            if (
              connected?._tag === "Some" &&
              !hostServes(connected.value.hello, "app-tools-tunnel")
            )
              return { failed: noAppToolsTunnel(name) };
            return machine.id;
          }
          if (machine === undefined) {
            // No later than the deadline, however long the app or the server takes to answer.
            const left = deadline - now();
            if (left <= 0) return { failed: "timeout" };
            const read = yield* port
              .call(origin, "status", { name })
              .pipe(Effect.timeoutOption(left));
            if (read._tag === "None") return { failed: "timeout" };
            const answered = read.value;
            // A call that went wrong on the way is asked again, until the deadline.
            const status = answered.ok ? parseMachineStatus(answered.body) : {};
            if (
              answered.ok &&
              (answered.status === 404 || status.phase === "failed" || status.phase === "stopped")
            )
              return {
                failed: failedWords(
                  name,
                  status.message ?? `${server.server} says it isn't starting.`,
                ),
              };
            if (answered.ok && answered.status < 300 && status.publicKey !== undefined) {
              // So many relays at once is a leak, not work: refused, and this one given back.
              const held = hosts.list().filter((each) => each.via !== undefined).length;
              if (held >= RELAYED_MOST)
                return {
                  failed: `This Gram already has ${held} machines from hosted servers. Remove ones no worker uses under Settings → Machines, then spawn again.`,
                };
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
      }).pipe(
        // Registered by now, or given back next: no longer a start on its way either way.
        Effect.ensuring(Effect.sync(() => deps.starting?.delete(name))),
      ),
    timedOut: (name) =>
      Effect.map(forget(name), (stopped) => {
        const within = `The machine ${name} didn't join within ${Math.round((deps.timeoutMs ?? ARRIVE_TIMEOUT_MS) / 60_000)} minutes`;
        return stopped
          ? `${within}, so it was stopped. Spawn again to ask for a new one, or leave out sandbox to run the worker on your machine.`
          : `${within}, and ${server.server} didn't confirm stopping it: it stays listed under Machines until the server reclaims it. Leave out sandbox to run the worker on your machine.`;
      }),
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
          : // Only the status: what a server answers isn't written to the log.
            Effect.fail(
              new Error(answered.ok ? `the server answered ${answered.status}` : "no answer"),
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

/** How often the app is told the whole list of machines it carries, whether or not it changed. */
export const RELAYS_RESYNC = Duration.minutes(1);
/** How often offline relayed machines are asked after, to forget one the server reclaimed. */
export const RECLAIMED_EVERY = Duration.minutes(10);

/**
 * Forgets each relayed worker machine that is offline and that its server answers it doesn't know
 * (`…/status` 404): reclaimed there once released, or removed. Online ones aren't asked.
 */
export const forgetReclaimed = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "remove">,
) =>
  Effect.gen(function* () {
    for (const machine of hosts.list()) {
      if (machine.via === undefined || machine.onDemand !== "worker") continue;
      if (machine.onlineSince !== undefined) continue;
      const answered = yield* port.call(machine.via, "status", { name: machine.name });
      if (!answered.ok || answered.status !== 404) continue;
      port.unrelay(machine.name);
      hosts.remove(HostId.make(machine.id));
    }
  });

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
    // The relay for one machine carries that machine's dial alone, never another's it holds.
    if (decision.machine.id !== machine.id) {
      dial.end(4401, "unauthorized: another machine's dial");
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
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const owed = config === undefined ? memoryOwedStops() : fileOwedStops(config.dataDir);
    /** Names a start is on its way for: no stop owed for an earlier one may end what it makes. */
    const starting = new Set<string>();
    const claimed = (name: string) =>
      starting.has(name) ||
      hosts.list().some((machine) => machine.name === name && machine.via !== undefined);
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
    // What the app carries is what is registered here: told whole at start (`fresh`, since a new
    // server knows none of the connections carried for the last), on every change of the machines,
    // and every minute besides, in case the app missed one.
    const relayed = () =>
      hosts
        .list()
        .filter((machine) => machine.via !== undefined && machine.onDemand === "worker")
        .map((machine) => ({ origin: machine.via!, name: machine.name }));
    let told = "";
    const sync = (fresh: boolean) => {
      const machines = relayed();
      const said = JSON.stringify(machines);
      if (!fresh && said === told) return;
      told = said;
      port.relays(machines, fresh);
    };
    sync(true);
    const unwatch = hosts.watch(() => sync(false));
    yield* Effect.addFinalizer(() => Effect.sync(unwatch));
    yield* Effect.sync(() => {
      told = "";
      sync(false);
    }).pipe(Effect.repeat(Schedule.spaced(RELAYS_RESYNC)), Effect.forkScoped);
    // A machine the server no longer knows (reclaimed after its release, or removed there) is
    // forgotten here, so its relay stops and its name is free.
    yield* forgetReclaimed(port, hosts).pipe(
      Effect.andThen(settleOwedStops(port, owed, claimed)),
      Effect.catchCause((cause) => Effect.logWarning("the reclaimed-machine pass failed", cause)),
      Effect.repeat(Schedule.spaced(RECLAIMED_EVERY)),
      Effect.forkScoped,
    );
    return {
      port,
      source: port.server().pipe(
        Effect.map((answered) =>
          answered.ok
            ? {
                source: signedInSource(answered.server, { port, hosts, offered, owed, starting }),
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
