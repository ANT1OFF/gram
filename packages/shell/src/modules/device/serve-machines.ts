// This machine's server asks the app for machines of a worker's own from a hosted server
// (`packages/server/src/embedding/signed-in-workers.ts`, `docs/design/desktop-worker-machines.md`).
// The app holds the sign-in, so it makes each call, and it carries each such machine's connection:
// it dials the server's relay for the machine, and passes what comes through to this machine's
// server as frames over the same port, and back. It reads nothing in those frames but the first,
// which says how the host signed its dial; the server checks that signature itself.

import { randomUUID } from "node:crypto";

import {
  RelayDialFrame,
  WORKER_MACHINE_CALLS,
  WORKER_MACHINE_NAME,
  type WorkerMachineCall,
  type WorkerMachineRelayMessage,
  type WorkerMachineResult,
  type WorkerMachineSignInsMessage,
} from "@gram/contracts";
import * as Schema from "effect/Schema";

import type { HostedDevice } from "./hosted-device.ts";

const NONE: WorkerMachineResult = { ok: false, why: "Hosted features are off in this app." };
const MALFORMED: WorkerMachineResult = { ok: false, why: "The request isn't one the app sends." };

/** The first wait after a relay ends, doubled each time up to the last. */
const RETRY_FIRST_MS = 2_000;
const RETRY_MOST_MS = 60_000;
/** A relay that lasted this long resets the wait. */
const STEADY_MS = 60_000;
/** How long the relay may take to say how the host dialled, once it is open. */
const FIRST_FRAME_MS = 30_000;
/** The most bytes of one frame passed on: the host protocol's frames are far smaller. */
const FRAME_MOST_BYTES = 16 * 1024 * 1024;
/** How many machines' connections the app carries at once. */
const RELAYS_MOST = 64;
/** How often live relays are checked against the sign-in, besides each change of it. */
const REVALIDATE_MS = 30_000;
/**
 * How often a live relay's lease is renewed: a token is had for it again, which renews the sign-in
 * when due, so a sign-in that expired or was revoked there ends its relays within this long.
 */
export const RELAY_LEASE_MS = 5 * 60_000;

/** Closes a socket with a code Node's WebSocket takes (1000, or 3000–4999), never throwing. */
const closeSafely = (socket: RelaySocket, code: number, reason: string) => {
  try {
    socket.close(
      code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000,
      reason.slice(0, 120),
    );
  } catch {
    // Already closed.
  }
};

const isRequest = (message: unknown): message is { type: "machines.request"; id: string } =>
  typeof message === "object" &&
  message !== null &&
  Reflect.get(message, "type") === "machines.request" &&
  typeof Reflect.get(message, "id") === "string" &&
  (Reflect.get(message, "id") as string).length <= 64;

const textOf = (message: object, name: string, most: number): string | undefined => {
  const value = Reflect.get(message, name);
  return typeof value === "string" && value.length > 0 && value.length <= most ? value : undefined;
};

/** A WebSocket as the relay uses one: Node's and Electron's, which take handshake headers. */
export interface RelaySocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: never) => void,
  ): void;
}

export type OpenRelaySocket = (url: string, headers: Record<string, string>) => RelaySocket;

/** Node's own WebSocket, handed the headers as its options (the browser's can't take them). */
export const nodeRelaySocket: OpenRelaySocket = (url, headers) =>
  new globalThis.WebSocket(url, { headers } as unknown as string[]) as unknown as RelaySocket;

export interface WorkerMachineRelays {
  /**
   * Keep carrying `name`'s connection, from the server at `origin`: under the sign-in `account`
   * alone, where one is given.
   */
  readonly relay: (origin: string, name: string, account?: string) => void;
  readonly unrelay: (name: string) => void;
  /**
   * Carry exactly these: each one missing is relayed, each other stopped. `fresh`: the server
   * just started and knows none of the connections carried for the one before, so every live one
   * is closed and dialled again.
   */
  readonly sync: (
    machines: ReadonlyArray<{
      readonly origin: string;
      readonly name: string;
      readonly account?: string | undefined;
    }>,
    fresh: boolean,
  ) => void;
  /**
   * Closes every live relay the sign-in no longer covers: signed out, or the sign-in ended, or
   * hosted features turned off. Each dials again only once it is covered again. Called on every
   * change of the device: when the sign-ins' marks are not as last told (one signed in or out, a
   * renewal's new mark), this machine's server is told so (`machines.signins`), and moves what
   * former marks hold now rather than at its next pass.
   */
  readonly revalidate: () => void;
  /** A frame or an end from this machine's server, for a connection the app carries. */
  readonly fromServer: (message: WorkerMachineRelayMessage) => void;
  /** Stops every relay, as the app quits. */
  readonly close: () => void;
}

interface Wanted {
  readonly origin: string;
  /** The sign-in it is carried under alone (`WorkerMachineServer.account`), where one is. */
  readonly account?: string | undefined;
  stopped: boolean;
  socket?: RelaySocket;
  conn?: string;
  timer?: ReturnType<typeof setTimeout>;
  waitMs: number;
}

/**
 * The relays the app carries. Each dials again whenever it ends, after a wait that grows while
 * dials keep failing, until the server says to stop or the app quits.
 */
export const makeWorkerMachineRelays = (options: {
  readonly device: () => HostedDevice | undefined;
  readonly post: (message: WorkerMachineRelayMessage | WorkerMachineSignInsMessage) => void;
  readonly open?: OpenRelaySocket;
  readonly now?: () => number;
  /** Whether a timer checks live relays against the sign-in; off in tests that drive it. */
  readonly watch?: boolean;
  /** How often each live relay's lease is renewed. */
  readonly leaseMs?: number;
}): WorkerMachineRelays => {
  const open = options.open ?? nodeRelaySocket;
  const now = options.now ?? Date.now;
  const wanted = new Map<string, Wanted>();
  const byConn = new Map<string, Wanted>();

  const again = (name: string, entry: Wanted, since: number | undefined) => {
    if (entry.stopped || wanted.get(name) !== entry) return;
    entry.waitMs =
      since !== undefined && now() - since >= STEADY_MS
        ? RETRY_FIRST_MS
        : Math.min(entry.waitMs * 2, RETRY_MOST_MS);
    entry.timer = setTimeout(() => void dial(name, entry), entry.waitMs);
  };

  /** Whether the sign-in covers carrying a machine from `origin` now. */
  const covered = (entry: Wanted) =>
    options.device()?.workerMachineRelayAllowed(entry.origin, entry.account) === true;

  const dial = async (name: string, entry: Wanted) => {
    if (entry.stopped) return;
    const device = options.device();
    const prepared =
      device === undefined || !covered(entry)
        ? undefined
        : await device
            .workerMachineRelayDial(entry.origin, name, entry.account)
            .catch(() => undefined);
    if (entry.stopped) return;
    // Covered again as it opens: a sign-out or another sign-in while the dial was prepared (a
    // token renewal, a nonce) opens nothing under the old one.
    if (prepared === undefined || !prepared.ok || !covered(entry)) {
      again(name, entry, undefined);
      return;
    }
    let socket: RelaySocket;
    try {
      socket = open(prepared.url, prepared.headers);
    } catch {
      again(name, entry, undefined);
      return;
    }
    socket.binaryType = "arraybuffer";
    entry.socket = socket;
    let opened: number | undefined;
    let conn: string | undefined;
    const firstFrame = setTimeout(
      () => closeSafely(socket, 4408, "no dial came through"),
      FIRST_FRAME_MS,
    );
    socket.addEventListener("open", () => {
      opened = now();
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      if (typeof data !== "string" && !(data instanceof Uint8Array)) return;
      const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
      if (size > FRAME_MOST_BYTES) {
        // 1009 is the standard's own code, which Node's WebSocket refuses to send.
        closeSafely(socket, 4009, "frame too large");
        return;
      }
      if (conn !== undefined) {
        options.post({ type: "machines.relay.frame", conn, data });
        return;
      }
      // The first: how the host signed its dial, which the server checks.
      clearTimeout(firstFrame);
      let first: unknown;
      try {
        first = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      } catch {
        first = undefined;
      }
      const decoded = Schema.decodeUnknownOption(RelayDialFrame)(first);
      if (decoded._tag === "None") {
        closeSafely(socket, 4400, "the relay's first frame isn't a dial");
        return;
      }
      conn = randomUUID();
      entry.conn = conn;
      byConn.set(conn, entry);
      options.post({
        type: "machines.relay.dial",
        conn,
        origin: entry.origin,
        name,
        headers: decoded.value.dial.headers,
      });
    });
    socket.addEventListener("close", () => {
      clearTimeout(firstFrame);
      if (conn !== undefined) {
        byConn.delete(conn);
        options.post({ type: "machines.relay.end", conn });
      }
      if (entry.socket === socket) {
        delete entry.socket;
        delete entry.conn;
      }
      again(name, entry, opened);
    });
    socket.addEventListener("error", () => undefined);
  };

  const stop = (entry: Wanted) => {
    entry.stopped = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.socket !== undefined) closeSafely(entry.socket, 1000, "no longer relayed");
  };

  const relay = (origin: string, name: string, account?: string) => {
    const kept = wanted.get(name);
    if (kept !== undefined && kept.origin === origin && kept.account === account && !kept.stopped)
      return;
    if (kept !== undefined) stop(kept);
    if (wanted.size >= RELAYS_MOST && kept === undefined) return;
    const entry: Wanted = {
      origin,
      ...(account === undefined ? {} : { account }),
      stopped: false,
      waitMs: RETRY_FIRST_MS / 2,
    };
    wanted.set(name, entry);
    void dial(name, entry);
  };
  const unrelay = (name: string) => {
    const kept = wanted.get(name);
    if (kept === undefined) return;
    wanted.delete(name);
    stop(kept);
  };
  let toldMarks: string | undefined;
  const revalidate = () => {
    for (const entry of wanted.values())
      if (entry.socket !== undefined && !covered(entry))
        closeSafely(entry.socket, 4401, "signed out");
    const marks = JSON.stringify(options.device()?.workerMachineMarks() ?? []);
    if (marks === toldMarks) return;
    toldMarks = marks;
    options.post({ type: "machines.signins" });
  };
  const watcher = options.watch === false ? undefined : setInterval(revalidate, REVALIDATE_MS);
  watcher?.unref?.();
  /** Renews each live relay's lease, closing those whose sign-in can't be had any more. */
  const renew = async () => {
    // A copy: the list may change while a renewal is awaited.
    for (const entry of Array.from(wanted.values())) {
      const socket = entry.socket;
      if (socket === undefined) continue;
      const device = options.device();
      const leased =
        device === undefined
          ? false
          : await device.workerMachineRelayLease(entry.origin, entry.account).catch(() => false);
      if (!leased && entry.socket === socket) closeSafely(socket, 4401, "sign-in ended");
    }
  };
  const leaser = setInterval(() => void renew(), options.leaseMs ?? RELAY_LEASE_MS);
  leaser.unref?.();

  return {
    relay,
    unrelay,
    sync: (machines, fresh) => {
      const named = new Map(machines.map((each) => [each.name, each]));
      // Deleting from a Map as it is iterated is safe: what is left is still visited.
      for (const name of wanted.keys()) {
        const listed = named.get(name);
        const kept = wanted.get(name);
        if (listed?.origin !== kept?.origin || listed?.account !== kept?.account) unrelay(name);
      }
      // A server just started knows none of the connections carried for the one before it.
      if (fresh)
        for (const entry of wanted.values())
          if (entry.socket !== undefined) closeSafely(entry.socket, 4503, "Gram restarted");
      for (const [name, each] of named) relay(each.origin, name, each.account);
    },
    revalidate,
    fromServer: (message) => {
      const entry = byConn.get(message.conn);
      const socket = entry?.socket;
      if (entry === undefined || socket === undefined || entry.conn !== message.conn) return;
      if (message.type === "machines.relay.frame") {
        const size =
          typeof message.data === "string"
            ? Buffer.byteLength(message.data, "utf8")
            : message.data.byteLength;
        // Bounded both ways, as what comes from the relay is.
        if (size > FRAME_MOST_BYTES) {
          closeSafely(socket, 4009, "frame too large");
          return;
        }
        socket.send(message.data);
        return;
      }
      if (message.type === "machines.relay.end") {
        byConn.delete(message.conn);
        closeSafely(socket, message.code ?? 1000, message.reason ?? "");
      }
    },
    close: () => {
      if (watcher !== undefined) clearInterval(watcher);
      clearInterval(leaser);
      for (const entry of wanted.values()) stop(entry);
      wanted.clear();
      byConn.clear();
    },
  };
};

/** A relay message from this machine's server, read field by field. */
const serverRelayMessageOf = (message: unknown): WorkerMachineRelayMessage | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const type = Reflect.get(message, "type");
  const conn = Reflect.get(message, "conn");
  if (typeof conn !== "string" || conn.length > 64) return undefined;
  if (type === "machines.relay.frame") {
    const data = Reflect.get(message, "data");
    return typeof data === "string" || data instanceof Uint8Array
      ? { type, conn, data }
      : undefined;
  }
  if (type === "machines.relay.end") {
    const code = Reflect.get(message, "code");
    const reason = Reflect.get(message, "reason");
    return {
      type,
      conn,
      ...(typeof code === "number" && Number.isInteger(code) ? { code } : {}),
      ...(typeof reason === "string" ? { reason: reason.slice(0, 120) } : {}),
    };
  }
  return undefined;
};

/** The fields this machine's server reads of each call's answer. */
const ANSWER_FIELDS: Readonly<Record<WorkerMachineCall, ReadonlyArray<string>>> = {
  choices: ["choices", "note", "keeps", "models"],
  // `code` names the answer where a status alone doesn't (`name_in_use`, `released`, `not_found`).
  start: ["code", "name", "message", "asked", "inUse", "total", "machines"],
  status: ["code", "phase", "message", "step", "publicKey", "platform"],
  release: ["code", "known", "released", "message"],
  stop: ["code", "stopped", "message"],
};

const answerFields = (call: WorkerMachineCall, body: unknown): unknown => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const field of ANSWER_FIELDS[call])
    if (Object.hasOwn(body, field)) kept[field] = Reflect.get(body, field);
  return kept;
};

/** A sign-in's mark as the server sends it (`WorkerMachineServer.account`). */
const isMark = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

/** The `relays` op's list, read entry by entry; undefined when it isn't one. */
const relaysOf = (
  value: unknown,
):
  | ReadonlyArray<{ readonly origin: string; readonly name: string; readonly account?: string }>
  | undefined => {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const listed: Array<{ origin: string; name: string; account?: string }> = [];
  for (const each of value) {
    if (typeof each !== "object" || each === null) return undefined;
    const origin = Reflect.get(each, "origin");
    const name = Reflect.get(each, "name");
    const account = Reflect.get(each, "account");
    if (
      typeof origin !== "string" ||
      origin.length > 512 ||
      typeof name !== "string" ||
      !WORKER_MACHINE_NAME.test(name) ||
      (account !== undefined && !isMark(account))
    )
      return undefined;
    listed.push({ origin, name, ...(account === undefined ? {} : { account }) });
  }
  return listed;
};

/** Answers one request from the server, or undefined for any other message. */
export const answerWorkerMachines = async (
  message: unknown,
  device: HostedDevice | undefined,
  relays: WorkerMachineRelays,
): Promise<{ type: "machines.response"; id: string; result: WorkerMachineResult } | undefined> => {
  if (!isRequest(message)) return undefined;
  const respond = (result: WorkerMachineResult) => ({
    type: "machines.response" as const,
    id: message.id,
    result,
  });
  const op = Reflect.get(message, "op");
  // What to carry is kept whether or not the sign-in is there yet: an app still restoring it, or
  // one with hosted features off, dials each once it is covered (`revalidate`).
  if (op === "unrelay") {
    const name = textOf(message, "name", 40);
    if (name === undefined || !WORKER_MACHINE_NAME.test(name)) return respond(MALFORMED);
    relays.unrelay(name);
    return respond({ ok: true });
  }
  if (op === "relays") {
    const listed = relaysOf(Reflect.get(message, "machines"));
    if (listed === undefined) return respond(MALFORMED);
    relays.sync(listed, Reflect.get(message, "fresh") === true);
    return respond({ ok: true });
  }
  if (op === "relay") {
    const origin = textOf(message, "origin", 512);
    const name = textOf(message, "name", 40);
    const account = Reflect.get(message, "account");
    if (
      origin === undefined ||
      name === undefined ||
      !WORKER_MACHINE_NAME.test(name) ||
      (account !== undefined && !isMark(account))
    )
      return respond(MALFORMED);
    relays.relay(origin, name, account);
    return respond({ ok: true });
  }
  if (device === undefined) return respond(NONE);
  if (op === "server") {
    const found = device.workerMachineServer();
    return respond(found.ok ? { ok: true, server: found.server } : { ok: true, why: found.why });
  }
  if (op === "marks") return respond({ ok: true, marks: device.workerMachineMarks() });
  const origin = textOf(message, "origin", 512);
  if (origin === undefined) return respond(MALFORMED);
  if (op === "call") {
    const call = Reflect.get(message, "call");
    const body = Reflect.get(message, "body");
    if (
      typeof call !== "string" ||
      !(WORKER_MACHINE_CALLS as readonly string[]).includes(call) ||
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      JSON.stringify(body).length > 8 * 1024
    )
      return respond(MALFORMED);
    const sendBy = Reflect.get(message, "sendBy");
    if (sendBy !== undefined && !Number.isSafeInteger(sendBy)) return respond(MALFORMED);
    const account = Reflect.get(message, "account");
    if (account !== undefined && (typeof account !== "string" || account.length > 64))
      return respond(MALFORMED);
    const answered = await device.workerMachineCall(
      origin,
      call as WorkerMachineCall,
      body as Record<string, unknown>,
      sendBy as number | undefined,
      account,
    );
    // Only the fields this machine's server reads of each answer: nothing else a server sends,
    // a token it echoed say, leaves the app.
    return respond(
      answered.ok
        ? {
            ok: true,
            status: answered.status,
            body: answerFields(call as WorkerMachineCall, answered.body),
          }
        : answered,
    );
  }
  return respond(MALFORMED);
};

/**
 * Serves the server's worker-machine requests and relayed frames: each request answered on
 * `reply`, never thrown.
 */
export const serveWorkerMachineMessage = (
  message: unknown,
  device: HostedDevice | undefined,
  relays: WorkerMachineRelays,
  reply: (message: unknown) => void,
): void => {
  const relayed = serverRelayMessageOf(message);
  if (relayed !== undefined) {
    relays.fromServer(relayed);
    return;
  }
  if (!isRequest(message)) return;
  void answerWorkerMachines(message, device, relays)
    .catch(() => ({
      type: "machines.response" as const,
      id: (message as { id: string }).id,
      result: { ok: false as const, why: "The app couldn't make the call." },
    }))
    .then((response) => {
      if (response !== undefined) reply(response);
    });
};
