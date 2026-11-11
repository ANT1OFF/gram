import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIME_HEADER,
  type DeviceExecEvent,
  DeviceRpcs,
  type HostedDiscovery,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLendable } from "./folders.ts";
import type { AskAnswer, AskRequest, GateFolder } from "./gate.ts";
import { makeGrantLedger } from "./grants.ts";
import type { HostedToken, TokenFor, TokenKeeper } from "./hosted.ts";
import {
  deviceDialHolds,
  deviceIdOf,
  devicePrivateKeyFrom,
  devicePublicKeyText,
  generateDeviceKey,
  hashAccessToken,
} from "./keys.ts";
import { type LentWorkspace, makeServerLending } from "./lending.ts";
import { makeAskLimits } from "./limits.ts";

const ORIGIN = "https://gram.example.com";
const FOLDER_ID = "f-0123456789abcdef";

const discovery: HostedDiscovery = {
  version: 1,
  issuer: ORIGIN,
  name: "Example",
  client_id: "gram-desktop",
  authorization_endpoint: `${ORIGIN}/oauth/authorize`,
  token_endpoint: `${ORIGIN}/oauth/token`,
  workspaces_endpoint: `${ORIGIN}/api/workspaces`,
  devices_endpoint: `${ORIGIN}/api/devices`,
  device_connect: "wss://gram.example.com/device/connect",
};

/** Two sockets joined back to back; `close` ends both directions, as a dropped connection does. */
const socketPair = () =>
  Effect.gen(function* () {
    const ends: Array<TransformStreamDefaultController<Uint8Array>> = [];
    const pipe = () =>
      new TransformStream<Uint8Array, Uint8Array>({
        start: (controller) => {
          ends.push(controller);
        },
      });
    const there = pipe();
    const back = pipe();
    const device = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: there.readable, writable: back.writable }),
    );
    const server = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: back.readable, writable: there.writable }),
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const end of ends) end.terminate();
    };
    return { device, server, close, closed: () => closed };
  });

/** A keeper whose tokens last as long as the test says. */
const fakeKeeper = (lastsMs: { value: number }, elapsed: () => number) => {
  let count = 0;
  let signedOut = false;
  const asked: Array<string> = [];
  const keeper: TokenKeeper = {
    subject: "person-ada",
    nonce: {},
    signedOut: () => signedOut,
    signOut: async () => {
      signedOut = true;
    },
    unsaved: () => false,
    token: async (scope) => keeper.fresh(scope),
    fresh: async (scope): Promise<TokenFor> => {
      asked.push(scope);
      if (signedOut) return { ok: false, why: "Signed out.", signedOut: true };
      count += 1;
      const token: HostedToken = {
        accessToken: `token-${count}`,
        tokenType: "DPoP",
        expiresAt: elapsed() + lastsMs.value,
        subject: "person-ada",
      };
      return { ok: true, token };
    },
  };
  return { keeper, asked, signOut: () => void keeper.signOut() };
};

let base: string;
let folder: GateFolder;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-lending-")));
  const home = join(base, "home", "ada");
  const app = join(home, "code", "app");
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(join(app, "README.md"), "hello");
  const lent = await checkLendable(app, { home, ownFolders: [], agentHomes: [] });
  if (!lent.ok) throw new Error(lent.why);
  folder = {
    path: lent.path,
    device: lent.device,
    inode: lent.inode,
    bounds: { home, ownFolders: [], agentHomes: [] },
    label: "app",
  };
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((next) => setTimeout(next, 5));
  if (!done()) throw new Error(`Never: ${what}`);
};

/** The device lending to a fake control plane, which takes each dial as the device makes it. */
const setUp = async (options: { lastsMs?: number } = {}) => {
  const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
  const deviceId = deviceIdOf(devicePublicKeyText(key));
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  const lasts = { value: options.lastsMs ?? 600_000 };
  const tokens = fakeKeeper(lasts, elapsed);
  const grants = makeGrantLedger(key, () => Date.now());
  const limits = makeAskLimits(elapsed);
  const state = {
    present: true,
    workspaces: [
      { id: "w1", folders: new Map([[FOLDER_ID, folder]]), capabilities: ["read", "exec"] },
    ] as Array<LentWorkspace>,
    answer: (request: AskRequest): Promise<AskAnswer> =>
      Promise.resolve({ allowed: true, hash: request.hash }),
  };
  const dials: Array<{
    url: URL;
    headers: Readonly<Record<string, string>>;
    pair: Effect.Success<ReturnType<typeof socketPair>>;
  }> = [];
  const connections: Array<string> = [];
  const scope = await Effect.runPromise(Scope.make());
  const lending = await Effect.runPromise(
    makeServerLending({
      origin: ORIGIN,
      discovery,
      key,
      deviceId,
      platform: "linux",
      personId: "person-ada",
      keeper: tokens.keeper,
      grants,
      limits,
      workspaces: () => state.workspaces,
      present: () => state.present,
      ask: (request) => state.answer(request),
      environment: () => ({ env: { PATH: process.env.PATH ?? "/bin" }, secrets: [] }),
      log: async () => undefined,
      now: () => Date.now(),
      elapsed,
      retryFirstMs: 20,
      connect: (url, headers) =>
        Effect.gen(function* () {
          const pair = yield* socketPair();
          dials.push({ url, headers, pair });
          return pair.device;
        }),
      onConnection: (workspace, change) => connections.push(`${workspace} ${change}`),
    }).pipe(Scope.provide(scope)),
  );
  /** The control plane's client on the latest dial. */
  const client = () =>
    Effect.gen(function* () {
      const dial = dials.at(-1);
      if (dial === undefined) throw new Error("No dial");
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, dial.pair.server),
        Effect.provide(RpcSerialization.layerNdjson),
      );
      return yield* RpcClient.make(DeviceRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
    });
  const request = (requestId: string, thread = "t1") => ({
    requestId,
    grant: grants.mint({ origin: ORIGIN, workspace: "w1", thread }),
    thread: { id: thread, title: "Fix the build" },
    actor: { id: "person-ada", name: "Ada" },
    folderId: FOLDER_ID,
  });
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return {
    lending,
    state,
    dials,
    client,
    request,
    tokens,
    grants,
    limits,
    lasts,
    connections,
    close,
    deviceId,
    key,
  };
};

describe.skipIf(process.platform === "win32")("lending to a hosted server", () => {
  it("dials each lent workspace with signed headers, and serves its requests", async () => {
    const { lending, dials, client, request, close, deviceId, key } = await setUp();
    lending.sync();
    await until(() => dials.length === 1, "a dial");
    const dial = dials[0];
    expect(dial?.url.href).toBe("wss://gram.example.com/device/connect?workspace=w1");
    const headers = dial?.headers ?? {};
    expect(headers.authorization).toBe("DPoP token-1");
    expect(
      deviceDialHolds(
        (await import("node:crypto")).createPublicKey(key),
        {
          origin: ORIGIN,
          path: "/device/connect",
          workspace: "w1",
          subject: "person-ada",
          deviceId,
          tokenHash: hashAccessToken("token-1"),
          time: Number(headers[DEVICE_TIME_HEADER]),
          nonce: headers[DEVICE_NONCE_HEADER] ?? "",
        },
        headers[DEVICE_SIGNATURE_HEADER] ?? "",
        Date.now(),
      ),
    ).toBe(true);
    expect(headers[DEVICE_ID_HEADER]).toBe(deviceId);
    await Effect.runPromise(
      Effect.gen(function* () {
        const rpc = yield* client();
        const hello = yield* rpc["device.hello"]();
        expect(hello.folders).toEqual([{ id: FOLDER_ID, label: "app" }]);
        const events = yield* rpc["device.exec"]({ ...request("r1"), command: "echo lent" }).pipe(
          Stream.runCollect,
        );
        expect(
          [...events]
            .filter((event: DeviceExecEvent) => event.kind === "output")
            .map((event) => (event.kind === "output" ? event.text : "")),
        ).toEqual(["lent\n"]);
      }).pipe(Effect.scoped),
    );
    expect(lending.running()).toEqual(["w1"]);
    await close();
    expect(dials[0]?.pair.closed() ?? false).toBe(false);
  });

  it("hangs up when the person steps away, refusing what waited on them, and takes back grants", async () => {
    const { lending, state, dials, client, request, grants, close } = await setUp();
    state.answer = () => new Promise(() => undefined);
    lending.sync();
    await until(() => dials.length === 1, "a dial");
    const answer = Effect.runPromise(
      Effect.gen(function* () {
        const rpc = yield* client();
        return yield* rpc["device.files.read"]({
          ...request("r1"),
          path: "README.md",
          maxBytes: 10,
        });
      }).pipe(Effect.scoped),
    ).catch((error: unknown) => ({ failed: String(error) }));
    await new Promise((later) => setTimeout(later, 50));
    expect(grants.size()).toBe(1);
    state.present = false;
    lending.sync();
    await until(() => lending.running().length === 0, "the connection ends");
    expect(grants.size()).toBe(0);
    // The control plane sees the request end: refused as away, or the connection gone.
    const ended = await answer;
    expect(ended).not.toEqual({ kind: "read" });
    expect(dials).toHaveLength(1);
    await close();
  });

  it("closes the connection itself at the token's end, then dials again with a new one", async () => {
    const { lending, dials, connections, close } = await setUp({ lastsMs: 150 });
    lending.sync();
    await until(() => dials.length >= 2, "a second dial");
    expect(connections.slice(0, 2)).toEqual(["w1 connected", "w1 closed"]);
    expect(dials[1]?.headers.authorization).toBe("DPoP token-2");
    expect(dials[0]?.headers[DEVICE_NONCE_HEADER]).not.toBe(dials[1]?.headers[DEVICE_NONCE_HEADER]);
    await close();
  });

  it("keeps the connection past the first token's end when the server renews it", async () => {
    const { lending, dials, client, lasts, connections, close } = await setUp({ lastsMs: 300 });
    lending.sync();
    await until(() => dials.length === 1, "a dial");
    lasts.value = 600_000;
    await Effect.runPromise(
      Effect.gen(function* () {
        const rpc = yield* client();
        yield* rpc["device.token"]();
        yield* Effect.promise(() => new Promise((later) => setTimeout(later, 500)));
      }).pipe(Effect.scoped),
    );
    expect(connections).toEqual(["w1 connected"]);
    expect(dials).toHaveLength(1);
    await close();
  });

  it("refuses what waits on the person as paused when the server is paused", async () => {
    const { lending, state, dials, client, request, close } = await setUp();
    state.answer = () => new Promise(() => undefined);
    lending.sync();
    await until(() => dials.length === 1, "a dial");
    const events: Array<DeviceExecEvent> = [];
    const asked = Effect.runPromise(
      Effect.gen(function* () {
        const rpc = yield* client();
        yield* rpc["device.exec"]({ ...request("r1"), command: "ls" }).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        );
      }).pipe(Effect.scoped),
    ).catch(() => undefined);
    await until(() => events.length > 0, "the ask");
    await lending.stop("paused");
    await until(() => events.length > 1, "the refusal");
    expect(events.at(-1)).toEqual({ kind: "refused", why: "paused" });
    await asked;
    await close();
  });

  it("stops dialling when the sign-in has ended", async () => {
    const { lending, dials, tokens, close } = await setUp({ lastsMs: 100 });
    lending.sync();
    await until(() => dials.length === 1, "a dial");
    tokens.signOut();
    await until(() => lending.running().length === 0, "lending ends");
    expect(dials).toHaveLength(1);
    await close();
  });
});
