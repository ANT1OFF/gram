import { randomUUID } from "node:crypto";

import {
  RelayDialFrame,
  WORKER_MACHINE_CALLS,
  WORKER_MACHINE_NAME,
  type WorkerMachineCall,
  type WorkerMachineRelayMessage,
  type WorkerMachineResult,
  type WorkerMachineSignInsMessage,
  WORKER_MACHINE_RELAYS_MOST,
} from "@gram/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { HostedDevice } from "./hosted-device.ts";

const NONE: WorkerMachineResult = { ok: false, why: "Hosted features are off in this app." };
const MALFORMED: WorkerMachineResult = { ok: false, why: "The request isn't one the app sends." };

const RETRY_FIRST_MS = 2_000;
const RETRY_MOST_MS = 60_000;
const STEADY_MS = 60_000;
const FIRST_FRAME_MS = 30_000;
const FRAME_MOST_BYTES = 16 * 1024 * 1024;
const REVALIDATE_MS = 30_000;
/**
 * How often a live relay's lease is renewed: a token is had for it again, which renews the sign-in
 * when due, so a sign-in that expired or was revoked there ends its relays within this long.
 */
export const RELAY_LEASE_MS = 5 * 60_000;

const closeSafely = (socket: RelaySocket, code: number, reason: string) => {
  try {
    socket.close(
      code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000,
      reason.slice(0, 120),
    );
  } catch (_alreadyClosed) {}
};

const isRequest = Schema.is(
  Schema.Struct({
    type: Schema.Literal("machines.request"),
    id: Schema.String.check(Schema.isMaxLength(64)),
    op: Schema.optional(Schema.Unknown),
  }),
);

const Text = (most: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(most));
const MachineName = Schema.String.check(Schema.isPattern(WORKER_MACHINE_NAME));
const Mark = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));

const decodeUnrelay = Schema.decodeUnknownOption(
  Schema.Struct({ name: Text(40).check(Schema.isPattern(WORKER_MACHINE_NAME)) }),
);

const decodeRelays = Schema.decodeUnknownOption(
  Schema.Struct({
    machines: Schema.Array(
      Schema.Struct({
        origin: Schema.String.check(Schema.isMaxLength(512)),
        name: MachineName,
        account: Schema.optional(Mark),
      }),
    ).check(Schema.isMaxLength(WORKER_MACHINE_RELAYS_MOST)),
    fresh: Schema.optional(Schema.Unknown),
  }),
);

const decodeRelay = Schema.decodeUnknownOption(
  Schema.Struct({
    origin: Text(512),
    name: Text(40).check(Schema.isPattern(WORKER_MACHINE_NAME)),
    account: Schema.optional(Mark),
  }),
);

const decodeOrigin = Schema.decodeUnknownOption(Schema.Struct({ origin: Text(512) }));

const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    call: Schema.Literals(WORKER_MACHINE_CALLS),
    body: Schema.Record(Schema.String, Schema.Unknown).check(
      Schema.makeFilter((body) => !Array.isArray(body) && JSON.stringify(body).length <= 8 * 1024),
    ),
    sendBy: Schema.optional(Schema.Number.check(Schema.makeFilter(Number.isSafeInteger))),
    account: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  }),
);

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
        closeSafely(socket, 4009, "frame too large");
        return;
      }
      if (conn !== undefined) {
        options.post({ type: "machines.relay.frame", conn, data });
        return;
      }
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
    if (wanted.size >= WORKER_MACHINE_RELAYS_MOST && kept === undefined) return;
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
  const renew = async () => {
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
      for (const name of wanted.keys()) {
        const listed = named.get(name);
        const kept = wanted.get(name);
        if (listed?.origin !== kept?.origin || listed?.account !== kept?.account) unrelay(name);
      }
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

const serverRelayMessageOf = (message: unknown): WorkerMachineRelayMessage | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("type" in message) || !("conn" in message)) return undefined;
  const { type, conn } = message;
  if (typeof conn !== "string" || conn.length > 64) return undefined;
  if (type === "machines.relay.frame") {
    const data = "data" in message ? message.data : undefined;
    return typeof data === "string" || data instanceof Uint8Array
      ? { type, conn, data }
      : undefined;
  }
  if (type === "machines.relay.end") {
    const code = "code" in message ? message.code : undefined;
    const reason = "reason" in message ? message.reason : undefined;
    return {
      type,
      conn,
      ...(typeof code === "number" && Number.isInteger(code) ? { code } : {}),
      ...(typeof reason === "string" ? { reason: reason.slice(0, 120) } : {}),
    };
  }
  return undefined;
};

const ANSWER_FIELDS: Readonly<Record<WorkerMachineCall, ReadonlyArray<string>>> = {
  choices: ["choices", "note", "keeps", "models", "sharing"],
  start: [
    "code",
    "name",
    "message",
    "asked",
    "inUse",
    "total",
    "machines",
    "sandboxId",
    "generation",
  ],
  status: [
    "code",
    "phase",
    "message",
    "step",
    "publicKey",
    "platform",
    "sandboxId",
    "generation",
    "moveRequested",
  ],
  release: ["code", "known", "released", "applied", "message", "workers"],
  stop: ["code", "stopped", "message", "workers"],
  resize: ["code", "state", "size", "start", "until", "message", "asked", "inUse", "total"],
  move: ["code", "moved", "message"],
  workers: ["code", "message", "workers", "cap", "size", "mode"],
  machines: ["code", "message", "machines"],
};

const answerFields = (call: WorkerMachineCall, body: unknown): unknown => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const fields: ReadonlyArray<string> = ANSWER_FIELDS[call];
  return Object.fromEntries(
    Object.entries(body).filter(([field]: [string, unknown]) => fields.includes(field)),
  );
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
  const { op } = message;
  if (op === "unrelay") {
    const unrelay = decodeUnrelay(message);
    if (Option.isNone(unrelay)) return respond(MALFORMED);
    relays.unrelay(unrelay.value.name);
    return respond({ ok: true });
  }
  if (op === "relays") {
    const listed = decodeRelays(message);
    if (Option.isNone(listed)) return respond(MALFORMED);
    relays.sync(
      listed.value.machines.map(({ account, ...machine }) =>
        account === undefined ? machine : { ...machine, account },
      ),
      listed.value.fresh === true,
    );
    return respond({ ok: true });
  }
  if (op === "relay") {
    const relay = decodeRelay(message);
    if (Option.isNone(relay)) return respond(MALFORMED);
    relays.relay(relay.value.origin, relay.value.name, relay.value.account);
    return respond({ ok: true });
  }
  if (device === undefined) return respond(NONE);
  if (op === "server") {
    const found = device.workerMachineServer();
    if (!found.ok) return respond({ ok: true, why: found.why });
    const logo = await device.workerMachineLogo(found.server.origin);
    return respond({
      ok: true,
      server: logo === undefined ? found.server : { ...found.server, logo },
    });
  }
  if (op === "marks") return respond({ ok: true, marks: device.workerMachineMarks() });
  const origin = decodeOrigin(message);
  if (Option.isNone(origin)) return respond(MALFORMED);
  if (op === "call") {
    const decoded = decodeCall(message);
    if (Option.isNone(decoded)) return respond(MALFORMED);
    const { call, body, sendBy, account } = decoded.value;
    const answered = await device.workerMachineCall(
      origin.value.origin,
      call,
      body,
      sendBy,
      account,
    );
    return respond(
      answered.ok
        ? { ok: true, status: answered.status, body: answerFields(call, answered.body) }
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
      id: message.id,
      result: { ok: false as const, why: "The app couldn't make the call." },
    }))
    .then((response) => {
      if (response !== undefined) reply(response);
    });
};
