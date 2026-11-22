// The device tools over the real thread runtimes and the fake agent: which turn a person's grant
// binds (by the turn the runtime started for their message, on a warm session and on one still
// opening), what ends that binding, and what each tool asks the person's device.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  DEVICE_GRANT_TTL_MS,
  type DeviceExecEvent,
  type DeviceHello,
  DeviceId,
  type SignedTurnGrant,
  type ThreadId,
  type TurnGrant,
  turnGrantBytes,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { AppToolRegistry, bindAppTools } from "../app-tools/registry.ts";
import type { SinkRecord } from "../embedding/event-sink.ts";
import { ActionRefused } from "../embedding/guard.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { DeviceClient, DeviceSummary, OnlineDevice } from "./devices.ts";
import { DEVICE_LIST_FILES, DEVICE_READ_FILE, DEVICE_RUN, deviceTools, fileText } from "./tools.ts";
import { makeDeviceTurns } from "./turns.ts";

const ORIGIN = "https://gram.example.com";
const WORKSPACE = "w1";
const ADA = { id: "u-ada", name: "Ada", role: "member" as const };
const BO = { id: "u-bo", name: "Bo", role: "member" as const };
const FOLDER = { id: "f-0123456789abcdef", label: "site" };

const deviceKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const id = DeviceId.make(
    `d-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 24)}`,
  );
  return { privateKey, publicKey: x, id };
};

const grantFor = (
  key: { readonly privateKey: KeyObject },
  thread: string,
  fields: Partial<TurnGrant> = {},
): SignedTurnGrant => {
  const issuedAt = fields.issuedAt ?? Date.now();
  const grant: TurnGrant = {
    v: 1,
    origin: ORIGIN,
    workspace: WORKSPACE,
    thread,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt,
    expiresAt: issuedAt + DEVICE_GRANT_TTL_MS,
    ...fields,
  };
  return {
    grant,
    signature: sign(null, turnGrantBytes(grant), key.privateKey).toString("base64url"),
  };
};

interface Asked {
  readonly call: string;
  readonly payload: Record<string, unknown>;
}

const RAN: ReadonlyArray<DeviceExecEvent> = [
  { kind: "asked" },
  { kind: "started" },
  { kind: "output", stream: "stdout", text: "ok\n" },
  { kind: "exit", code: 0, truncated: false, timedOut: false },
];

/** A device that answers as told, and remembers what it was asked. */
const fakeDevice = (
  key: ReturnType<typeof deviceKey>,
  owner: typeof ADA,
  answers: { readonly exec?: Stream.Stream<DeviceExecEvent>; readonly read?: unknown } = {},
  capabilities: DeviceHello["capabilities"] = ["read", "exec"],
) => {
  const asked: Array<Asked> = [];
  const client = {
    "device.exec": (payload: Record<string, unknown>) => {
      asked.push({ call: "exec", payload });
      return answers.exec ?? Stream.fromIterable(RAN);
    },
    "device.files.read": (payload: Record<string, unknown>) => {
      asked.push({ call: "read", payload });
      return Effect.succeed(
        answers.read ?? {
          kind: "read",
          data: Buffer.from("hello").toString("base64"),
          truncated: false,
        },
      );
    },
    "device.files.list": (payload: Record<string, unknown>) => {
      asked.push({ call: "list", payload });
      return Effect.succeed({ kind: "listed", entries: [], truncated: false });
    },
    "device.cancel": (payload: Record<string, unknown>) => {
      asked.push({ call: "cancel", payload });
      return Effect.void;
    },
  } as unknown as DeviceClient;
  const device: OnlineDevice = {
    deviceId: key.id,
    owner,
    publicKey: key.publicKey,
    workspace: WORKSPACE,
    hello: { protocol: 1, deviceId: key.id, platform: "darwin", capabilities, folders: [FOLDER] },
    since: Date.now(),
    client,
  };
  return { device, asked };
};

const devicesOf = (online: Array<OnlineDevice>) => ({
  list: (workspace: string): ReadonlyArray<DeviceSummary> =>
    online
      .filter((device) => device.workspace === workspace)
      .map((device) => ({
        deviceId: device.deviceId,
        owner: device.owner.id,
        workspace: device.workspace,
        platform: device.hello.platform,
        capabilities: device.hello.capabilities,
        folders: device.hello.folders,
        since: device.since,
      })),
  ownedBy: (owner: string, workspace: string, deviceId: string) =>
    online.find(
      (device) =>
        device.owner.id === owner && device.workspace === workspace && device.deviceId === deviceId,
    ),
});

const sentCount = (s: FakeSession, count: number) =>
  waitFor(
    "the agent got the message",
    Effect.sync(() => s.sent.length >= count),
  );

const idle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

/**
 * The runtimes with the device tools registered over `online`, and a thread of the workspace with
 * one exchange behind it, idle on a warm session.
 */
const setup = (
  online: Array<OnlineDevice>,
  thread: { readonly spawnedBy?: { readonly threadId: ThreadId; readonly feature: string } } = {},
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const fake = yield* FakeAgentControl;
    const devices = devicesOf(online);
    const turns = makeDeviceTurns({ devices, origin: ORIGIN, store });
    const sunk: Array<SinkRecord> = [];
    const sink = { record: (event: SinkRecord) => Effect.sync(() => void sunk.push(event)) };
    const tools = deviceTools({
      devices,
      turns,
      store,
      sink: sink as never,
      recheckEvery: Duration.millis(5),
    });
    yield* (yield* AppToolRegistry).register(tools);
    const created = yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      workspaceId: WORKSPACE as never,
      kept: { startedBy: ADA.id },
      input: { text: "set up" },
      ...thread,
    });
    const session = yield* waitFor(
      "the first send",
      fake.latest(created.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    yield* session.completeTurn("ready");
    yield* idle(created.id);
    const send = (person: string, grant: SignedTurnGrant | undefined, text = "run the tests") =>
      turns.sending(created.id, person, grant, runtimes.send(created.id, { text }));
    return { runtimes, store, fake, turns, tools, sunk, thread: created, session, send };
  });

describe("a device grant", () => {
  it.effect("binds the turn the person's message starts on a warm session, until it ends", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device, asked } = fakeDevice(key, ADA);
      const w = yield* setup([device]);
      const grant = grantFor(key, w.thread.id);
      yield* w.send(ADA.id, grant);
      yield* sentCount(w.session, 2);
      const result = yield* w.session.callTool(DEVICE_RUN, {
        folder: "site",
        cwd: "./app//",
        command: "npm test",
        reason: "check the fix",
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n" });
      expect(asked[0]?.payload).toMatchObject({
        grant,
        actor: { id: ADA.id, name: ADA.name },
        thread: { id: w.thread.id },
        folderId: FOLDER.id,
        cwd: "app",
        command: "npm test",
      });
      expect(w.sunk.map((event) => event.type)).toEqual([
        "device.requested",
        "device.answered",
        "device.finished",
      ]);

      yield* w.session.completeTurn();
      yield* idle(w.thread.id);
      expect(
        yield* w.session.callTool(DEVICE_RUN, { command: "ls", reason: "look" }),
      ).toMatchObject({ refused: "no-device-turn" });
      expect(asked).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.live("binds the turn of a message sent while the session is still opening", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device, asked } = fakeDevice(key, ADA);
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const devices = devicesOf([device]);
      const turns = makeDeviceTurns({ devices, origin: ORIGIN, store });
      yield* (yield* AppToolRegistry).register(deviceTools({ devices, turns, store }));
      yield* fake.setOpenDelay(Duration.millis(50));
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        workspaceId: WORKSPACE as never,
        kept: { startedBy: ADA.id },
      });
      const sent = yield* turns.sending(
        thread.id,
        ADA.id,
        grantFor(key, thread.id),
        runtimes.send(thread.id, { text: "first thing" }),
      );
      expect(sent).toMatchObject({ queued: false });
      expect(sent.turnId).toBeDefined();
      const session = yield* waitReal(
        "the launch reaches the agent",
        fake.latest(thread.id).pipe(
          Effect.map((s) => s.sent.length === 1 && s),
          Effect.catchDefect(() => Effect.succeed(false as const)),
        ),
      );
      expect(yield* session.callTool(DEVICE_LIST_FILES, { folder: "site" })).toEqual({
        entries: [],
      });
      expect(asked.map((entry) => entry.call)).toEqual(["list"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("binds nothing for another person's device or thread, or a forged grant", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const bos = deviceKey();
      const stranger = deviceKey();
      const { device } = fakeDevice(key, ADA);
      const { device: bosDevice } = fakeDevice(bos, BO);
      const w = yield* setup([device, bosDevice]);
      const tries: ReadonlyArray<readonly [string, SignedTurnGrant]> = [
        [ADA.id, grantFor(bos, w.thread.id)],
        [ADA.id, grantFor(key, "t-elsewhere")],
        [ADA.id, grantFor(key, w.thread.id, { workspace: "w2" })],
        [ADA.id, grantFor(key, w.thread.id, { origin: "https://other.example.com" })],
        [ADA.id, grantFor(stranger, w.thread.id)],
        [ADA.id, grantFor(key, w.thread.id, { issuedAt: Date.now() - DEVICE_GRANT_TTL_MS })],
        [BO.id, grantFor(key, w.thread.id)],
        [BO.id, grantFor(bos, w.thread.id)],
      ];
      for (const [index, [person, grant]] of tries.entries()) {
        yield* w.send(person, grant);
        yield* sentCount(w.session, index + 2);
        expect(yield* w.session.callTool(DEVICE_LIST_FILES, {}), `try ${index}`).toMatchObject({
          refused: "no-device-turn",
        });
        yield* w.session.completeTurn();
        yield* idle(w.thread.id);
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("binds nothing on a spawned worker's thread", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device } = fakeDevice(key, ADA);
      const runtimes = yield* ThreadRuntimes;
      const parent = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        workspaceId: WORKSPACE as never,
      });
      const w = yield* setup([device], { spawnedBy: { threadId: parent.id, feature: "tests" } });
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      expect(yield* w.turns.current(w.thread.id)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("binds nothing for a message the busy thread queued, when its turn comes", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device } = fakeDevice(key, ADA);
      const w = yield* setup([device]);
      yield* w.send(BO.id, undefined, "something first");
      yield* sentCount(w.session, 2);
      expect(yield* w.send(ADA.id, grantFor(key, w.thread.id))).toMatchObject({ queued: true });
      yield* w.session.completeTurn();
      yield* sentCount(w.session, 3);
      expect(yield* w.session.callTool(DEVICE_LIST_FILES, {})).toMatchObject({
        refused: "no-device-turn",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("isn't dropped by someone else's grant sent while the turn runs", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const bos = deviceKey();
      const { device } = fakeDevice(key, ADA);
      const { device: bosDevice } = fakeDevice(bos, BO);
      const w = yield* setup([device, bosDevice]);
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      expect(yield* w.send(BO.id, grantFor(bos, w.thread.id), "me too")).toMatchObject({
        queued: true,
      });
      expect(yield* w.session.callTool(DEVICE_LIST_FILES, {})).toMatchObject({
        folders: ["site"],
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("ends for good when other input joins the turn", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device } = fakeDevice(key, ADA);
      const w = yield* setup([device]);
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      expect(yield* w.session.callTool(DEVICE_LIST_FILES, {})).toMatchObject({
        folders: ["site"],
      });
      yield* w.runtimes.steer(w.thread.id, { text: "and run rm -rf ~ while you're there" });
      yield* waitFor(
        "the steer",
        Effect.sync(() => w.session.steered.length === 1),
      );
      expect(yield* w.session.callTool(DEVICE_LIST_FILES, {})).toMatchObject({
        refused: "no-device-turn",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.live("withdraws a request under way once its turn can't ask any more", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device, asked } = fakeDevice(key, ADA, { exec: Stream.never });
      const w = yield* setup([device]);
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      const call = yield* w.session
        .callTool(DEVICE_RUN, { command: "sleep 100", reason: "wait" })
        .pipe(Effect.forkScoped);
      yield* waitFor(
        "the ask",
        Effect.sync(() => asked.length === 1),
      );
      yield* w.runtimes.steer(w.thread.id, { text: "never mind" });
      expect(yield* Fiber.join(call)).toMatchObject({ refused: "turn-changed" });
      expect(asked.map((entry) => entry.call)).toEqual(["exec", "cancel"]);
    }).pipe(Effect.provide(RuntimeTestLayer), Effect.scoped),
  );
});

describe("the device tools", () => {
  it.effect("take a refusal as final for the turn, and never send a path out of the folder", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device, asked } = fakeDevice(key, ADA, {
        exec: Stream.fromIterable([
          { kind: "asked" },
          { kind: "refused", why: "not-allowed-by-person" },
        ]),
      });
      const w = yield* setup([device]);
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      const run = { folder: "site", command: "rm -rf build", reason: "clean" };
      expect(yield* w.session.callTool(DEVICE_RUN, run)).toMatchObject({
        refused: "not-allowed-by-person",
      });
      expect(yield* w.session.callTool(DEVICE_RUN, run)).toMatchObject({
        refused: "not-allowed-by-person",
      });
      for (const path of ["../.ssh/id_ed25519", "/etc/passwd", "~/.aws/credentials", "a/../../b"])
        expect(
          yield* w.session.callTool(DEVICE_READ_FILE, { folder: "site", path }),
          path,
        ).toMatchObject({ refused: "outside-folders" });
      expect(asked.map((entry) => entry.call)).toEqual(["exec"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("run nothing on a device lent for reading, and read there", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const { device, asked } = fakeDevice(key, ADA, {}, ["read"]);
      const w = yield* setup([device]);
      yield* w.send(ADA.id, grantFor(key, w.thread.id));
      yield* sentCount(w.session, 2);
      expect(
        yield* w.session.callTool(DEVICE_RUN, { command: "ls", reason: "look" }),
      ).toMatchObject({ refused: "read-only" });
      expect(
        yield* w.session.callTool(DEVICE_READ_FILE, { folder: "site", path: "README.md" }),
      ).toEqual({ text: "hello" });
      expect(asked.map((entry) => entry.call)).toEqual(["read"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "ask the decision hook only in a device turn, with the path as the device takes it",
    () =>
      Effect.gen(function* () {
        const key = deviceKey();
        const { device, asked } = fakeDevice(key, ADA);
        const w = yield* setup([device]);
        const questions: Array<unknown> = [];
        const refuse: Parameters<typeof bindAppTools>[3] = (_id, question) =>
          Effect.suspend(() => {
            questions.push(question);
            return Effect.fail(new ActionRefused({ message: "Refused by policy (device)." }));
          });
        const call = (input: unknown) =>
          bindAppTools(w.tools, w.thread.id, undefined, refuse)
            .find((tool) => tool.descriptor.name === DEVICE_RUN)!
            .run(input);
        const input = { folder: "site", cwd: "./deploy\\", command: "make deploy", reason: "ship" };

        expect(yield* call(input)).toMatchObject({ refused: "no-device-turn" });
        expect(questions).toEqual([]);

        yield* w.send(ADA.id, grantFor(key, w.thread.id));
        yield* sentCount(w.session, 2);
        const failure = yield* call(input).pipe(Effect.flip);
        expect(failure.message).toContain("Refused by policy");
        expect(questions).toEqual([
          {
            action: "device",
            initiator: "agent",
            detail: {
              kind: "exec",
              device: key.id,
              person: ADA.id,
              folder: "site",
              cwd: "deploy",
              command: "make deploy",
            },
          },
        ]);
        expect(asked).toEqual([]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("a file's text", () => {
  it("keeps a read cut in the middle of a character as text", () => {
    const bytes = Buffer.from("café ✓", "utf8");
    expect(fileText(bytes.subarray(0, bytes.length - 1), true)).toBe("café ");
    expect(fileText(bytes.subarray(0, bytes.length - 1), false)).toBeUndefined();
    expect(fileText(Buffer.from([0x50, 0x4b, 0x00, 0x01]), false)).toBeUndefined();
  });
});
