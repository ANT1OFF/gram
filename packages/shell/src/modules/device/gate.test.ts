import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceCapability, DeviceExecEvent, SignedTurnGrant } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLendable } from "./folders.ts";
import {
  type AskAnswer,
  type AskRequest,
  type DeviceGateOptions,
  type ExecPayload,
  type GateFolder,
  makeDeviceGate,
  UNASKED_LOG_WINDOW_MS,
  UNASKED_LOGGED_PER_WINDOW,
  UNASKED_WHAT_MOST,
} from "./gate.ts";
import { makeGrantLedger } from "./grants.ts";
import { devicePrivateKeyFrom, generateDeviceKey, mintTurnGrant } from "./keys.ts";
import {
  ASKS_PER_WINDOW,
  ASKS_WAITING_PER_THREAD,
  makeAskLimits,
  REFUSALS_IN_A_ROW,
} from "./limits.ts";
import type { DeviceLogEntry } from "./log.ts";

const ORIGIN = "https://gram.example.com";
const WORKSPACE = "w1";
const FOLDER_ID = "f-0123456789abcdef";

let base: string;
let home: string;
let app: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-gate-")));
  home = join(base, "home", "ada");
  app = join(home, "code", "app");
  await fs.mkdir(join(app, "src"), { recursive: true });
  await fs.writeFile(join(app, "README.md"), "hello");
  await fs.writeFile(join(app, ".env"), "TOKEN=x");
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const allowAll = async (request: AskRequest): Promise<AskAnswer> => ({
  allowed: true,
  hash: request.hash,
});

/** A fake ask window: answers as told, and records what it was shown. */
const window = () => {
  const shown: Array<AskRequest> = [];
  const withdrawn: Array<AskRequest> = [];
  let answer: (request: AskRequest) => Promise<AskAnswer> = allowAll;
  return {
    shown,
    withdrawn,
    answer: (next: (request: AskRequest) => Promise<AskAnswer>) => {
      answer = next;
    },
    ask: (request: AskRequest, signal: AbortSignal) => {
      shown.push(request);
      signal.addEventListener("abort", () => withdrawn.push(request), { once: true });
      return answer(request);
    },
  };
};

const setUp = async (more: Partial<DeviceGateOptions> = {}) => {
  const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
  const clock = { now: 1_800_000_000_000 };
  const grants = makeGrantLedger(key, () => clock.now);
  const limits = makeAskLimits(() => clock.now);
  const lent = await checkLendable(app, { home, ownFolders: [], agentHomes: [] });
  if (!lent.ok) throw new Error(lent.why);
  const folder: GateFolder = {
    path: lent.path,
    device: lent.device,
    inode: lent.inode,
    bounds: { home, ownFolders: [], agentHomes: [] },
    label: "app",
  };
  const log: Array<DeviceLogEntry> = [];
  const asks = window();
  const state = {
    present: true,
    lent: true,
    capabilities: ["read", "exec"] as Array<DeviceCapability>,
  };
  const gate = makeDeviceGate({
    origin: ORIGIN,
    workspace: WORKSPACE,
    personId: "ada",
    folders: () => new Map(state.lent ? [[FOLDER_ID, folder]] : []),
    capabilities: () => state.capabilities,
    present: () => state.present,
    grants,
    limits,
    ask: asks.ask,
    environment: () => ({ env: { PATH: process.env.PATH ?? "/bin" }, secrets: ["hunter2hunter2"] }),
    log: async (entry) => {
      log.push(entry);
    },
    now: () => clock.now,
    ...more,
  });
  const grant = grants.mint({ origin: ORIGIN, workspace: WORKSPACE, thread: "t1" });
  const by = (requestId: string, over: Partial<ExecPayload> = {}) => ({
    requestId,
    grant,
    thread: { id: "t1", title: "Fix the build" },
    actor: { id: "ada", name: "Ada" },
    folderId: FOLDER_ID,
    ...over,
  });
  const exec = async (payload: ExecPayload) => {
    const events: Array<DeviceExecEvent> = [];
    await gate.exec(payload, (event) => events.push(event));
    return events;
  };
  return { key, grants, limits, gate, asks, log, state, clock, grant, by, exec, folder };
};

/** Waits until the window has been shown `count` asks. */
const shownAsks = async (asks: { shown: ReadonlyArray<unknown> }, count: number) => {
  for (let tries = 0; asks.shown.length < count && tries < 500; tries += 1)
    await new Promise((later) => setTimeout(later, 10));
  expect(asks.shown).toHaveLength(count);
};

const outputOf = (events: ReadonlyArray<DeviceExecEvent>) =>
  events
    .filter((event) => event.kind === "output")
    .map((event) => (event.kind === "output" ? event.text : ""))
    .join("");

describe.skipIf(process.platform === "win32")("the device's gate", () => {
  it("runs a command the person allowed, in the folder, and redacts what it prints", async () => {
    const { exec, by, asks, log } = await setUp();
    const events = await exec({ ...by("r1"), cwd: "src", command: "pwd; echo hunter2hunter2" });
    expect(events.map((event) => event.kind)).toEqual(["asked", "started", "output", "exit"]);
    expect(outputOf(events)).toBe(`${join(app, "src")}\n[removed by Gram]\n`);
    expect(events.at(-1)).toMatchObject({ kind: "exit", code: 0 });
    const [shown] = asks.shown;
    expect(shown?.approval).toMatchObject({
      origin: ORIGIN,
      workspace: WORKSPACE,
      kind: "exec",
      folder: app,
      target: join(app, "src"),
      command: "pwd; echo hunter2hunter2",
      timeoutMs: 120_000,
    });
    expect(log).toMatchObject([{ kind: "exec", answer: "allowed", exitCode: 0, folder: app }]);
  });

  it("runs nothing when the person refuses, or allows something other than what was shown", async () => {
    const { exec, by, asks, folder } = await setUp();
    asks.answer(async () => ({ allowed: false }));
    const marker = join(folder.path, "ran");
    expect(await exec({ ...by("r1"), command: `touch ${marker}` })).toEqual([
      { kind: "asked" },
      { kind: "refused", why: "not-allowed-by-person" },
    ]);
    asks.answer(async () => ({ allowed: true, hash: "0".repeat(64) }));
    expect((await exec({ ...by("r2"), command: `touch ${marker}` })).at(-1)).toEqual({
      kind: "refused",
      why: "not-allowed-by-person",
    });
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("refuses, before any ask, a request for someone else, without a grant, or while away", async () => {
    const { exec, by, asks, state, key, grants } = await setUp();
    expect(
      await exec({ ...by("r1", { actor: { id: "bo", name: "Ada" } }), command: "ls" }),
    ).toEqual([{ kind: "refused", why: "not-for-this-person" }]);
    const forged = mintTurnGrant(
      key,
      { origin: ORIGIN, workspace: WORKSPACE, thread: "t1" },
      1_800_000_000_000,
    );
    expect(await exec({ ...by("r2", { grant: forged }), command: "ls" })).toEqual([
      { kind: "refused", why: "no-grant" },
    ]);
    expect(
      await exec({ ...by("r3", { thread: { id: "t2", title: "Other" } }), command: "ls" }),
    ).toEqual([{ kind: "refused", why: "no-grant" }]);
    grants.withdraw({});
    expect(await exec({ ...by("r4"), command: "ls" })).toEqual([
      { kind: "refused", why: "no-grant" },
    ]);
    state.present = false;
    expect(await exec({ ...by("r5"), command: "ls" })).toEqual([{ kind: "refused", why: "away" }]);
    expect(asks.shown).toHaveLength(0);
  });

  it("refuses a command where lending is read only, and an oversized one", async () => {
    const { exec, by, state } = await setUp();
    expect(await exec({ ...by("r1"), command: "x".repeat(9000) })).toEqual([
      { kind: "refused", why: "too-large" },
    ]);
    state.capabilities = ["read"];
    expect(await exec({ ...by("r2"), command: "ls" })).toEqual([
      { kind: "refused", why: "read-only" },
    ]);
  });

  it("refuses a folder or path outside what is lent, and counts it against the server", async () => {
    const { exec, by, gate, asks } = await setUp();
    expect(await exec({ ...by("r1", { folderId: "f-ffffffffffffffff" }), command: "ls" })).toEqual([
      { kind: "refused", why: "outside-folders" },
    ]);
    expect(await exec({ ...by("r2"), cwd: "..", command: "ls" })).toEqual([
      { kind: "refused", why: "outside-folders" },
    ]);
    expect(await gate.read({ ...by("r3"), path: ".env", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "credential-path",
    });
    for (let index = 4; index < 21; index += 1)
      await gate.read({ ...by(`r${index}`), path: "nope", maxBytes: 10 });
    // Twenty path refusals in ten minutes, and the server is told it asks too much.
    expect(await gate.read({ ...by("r21"), path: "README.md", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "too-many-requests",
    });
    expect(asks.shown).toHaveLength(0);
  });

  it("reads and lists only after an ask that shows the real path", async () => {
    const { gate, by, asks } = await setUp();
    const read = await gate.read({ ...by("r1"), path: "README.md", maxBytes: 100 });
    expect(read).toEqual({
      kind: "read",
      data: Buffer.from("hello").toString("base64"),
      truncated: false,
    });
    expect(asks.shown[0]?.approval).toMatchObject({ kind: "read", target: join(app, "README.md") });
    expect(asks.shown[0]?.size).toBe(5);
    const listed = await gate.list({ ...by("r2"), path: "", limit: 10 });
    expect(listed).toEqual({
      kind: "listed",
      entries: [
        { name: "README.md", kind: "file", size: 5 },
        { name: "src", kind: "folder" },
      ],
      truncated: false,
    });
  });

  it("refuses a read whose file moved after the person allowed it", async () => {
    const { gate, by, asks, folder } = await setUp();
    await fs.writeFile(join(folder.path, "a.txt"), "a");
    await fs.writeFile(join(folder.path, "b.txt"), "b");
    await fs.symlink(join(folder.path, "a.txt"), join(folder.path, "current"));
    asks.answer(async (request) => {
      await fs.rm(join(folder.path, "current"));
      await fs.symlink(join(folder.path, "b.txt"), join(folder.path, "current"));
      return { allowed: true, hash: request.hash };
    });
    expect(await gate.read({ ...by("r1"), path: "current", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "outside-folders",
    });
  });

  it("refuses a command whose folder moved after the person allowed it", async () => {
    const { exec, by, asks, folder } = await setUp();
    await fs.mkdir(join(folder.path, "other"));
    await fs.symlink(join(folder.path, "src"), join(folder.path, "here"));
    asks.answer(async (request) => {
      await fs.rm(join(folder.path, "here"));
      await fs.symlink(join(folder.path, "other"), join(folder.path, "here"));
      return { allowed: true, hash: request.hash };
    });
    expect((await exec({ ...by("r1"), cwd: "here", command: "pwd" })).at(-1)).toEqual({
      kind: "refused",
      why: "outside-folders",
    });
  });

  it("takes a request once: a repeat joins it, and a changed repeat is refused", async () => {
    const { gate, by, asks } = await setUp();
    const held: Array<() => void> = [];
    asks.answer(
      (request) =>
        new Promise((done) => {
          held.push(() => done({ allowed: true, hash: request.hash }));
        }),
    );
    const first: Array<DeviceExecEvent> = [];
    const second: Array<DeviceExecEvent> = [];
    const one = gate.exec({ ...by("r1"), command: "echo once" }, (event) => first.push(event));
    await shownAsks(asks, 1);
    const two = gate.exec({ command: "echo once", ...by("r1") }, (event) => second.push(event));
    const changed: Array<DeviceExecEvent> = [];
    await gate.exec({ ...by("r1"), command: "echo twice" }, (event) => changed.push(event));
    expect(changed).toEqual([{ kind: "refused", why: "changed-request" }]);
    for (const release of held) release();
    await Promise.all([one, two]);
    expect(asks.shown).toHaveLength(1);
    expect(outputOf(first)).toBe("once\n");
    expect(second).toEqual(first);
    // After it ended, a repeat answers with how it ended, without asking again.
    const third: Array<DeviceExecEvent> = [];
    await gate.exec({ ...by("r1"), command: "echo once" }, (event) => third.push(event));
    expect(third).toEqual(first);
    expect(asks.shown).toHaveLength(1);
    asks.answer(allowAll);
    const read = await gate.read({ ...by("r2"), path: "README.md", maxBytes: 10 });
    expect(await gate.read({ ...by("r2"), path: "README.md", maxBytes: 10 })).toEqual(read);
    expect(await gate.read({ ...by("r2"), path: "README.md", maxBytes: 11 })).toEqual({
      kind: "refused",
      why: "changed-request",
    });
  });

  it("withdraws an ask the server takes back, and stops a command it cancels", async () => {
    const { gate, by, asks } = await setUp();
    asks.answer(() => new Promise(() => undefined));
    const events: Array<DeviceExecEvent> = [];
    const waiting = gate.exec({ ...by("r1"), command: "echo never" }, (event) =>
      events.push(event),
    );
    await new Promise((later) => setTimeout(later, 20));
    gate.cancel("r1");
    await waiting;
    expect(events).toEqual([{ kind: "asked" }]);
    expect(asks.withdrawn).toHaveLength(1);
    asks.answer(allowAll);
    const running: Array<DeviceExecEvent> = [];
    const started = Date.now();
    const work = gate.exec({ ...by("r2"), command: "sleep 30" }, (event) => running.push(event));
    await new Promise((later) => setTimeout(later, 200));
    gate.cancel("r2");
    await work;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(running.at(-1)).toMatchObject({ kind: "exit", signal: "SIGTERM" });
    gate.cancel("unknown");
  });

  it("refuses an ask nobody answers in time", async () => {
    const { exec, by, asks } = await setUp({ askWaitMs: 50 });
    asks.answer(() => new Promise(() => undefined));
    expect((await exec({ ...by("r1"), command: "ls" })).at(-1)).toEqual({
      kind: "refused",
      why: "not-answered",
    });
    expect(asks.withdrawn).toHaveLength(1);
  });

  it("refuses everything waiting when the person steps away, without counting it", async () => {
    const { gate, by, asks, limits } = await setUp();
    asks.answer(() => new Promise(() => undefined));
    const events: Array<DeviceExecEvent> = [];
    const waiting = gate.exec({ ...by("r1"), command: "ls" }, (event) => events.push(event));
    const reading = gate.read({ ...by("r2"), path: "README.md", maxBytes: 10 });
    await shownAsks(asks, 2);
    gate.stopAll("away");
    await waiting;
    expect(events.at(-1)).toEqual({ kind: "refused", why: "away" });
    expect(await reading).toEqual({ kind: "refused", why: "away" });
    expect(asks.withdrawn).toHaveLength(2);
    expect(limits.waiting()).toBe(0);
    expect(limits.paused()).toBe(false);
  });

  it("pauses the server after three refused in a row", async () => {
    const { exec, by, asks } = await setUp();
    asks.answer(async () => ({ allowed: false }));
    for (let index = 0; index < REFUSALS_IN_A_ROW; index += 1)
      await exec({ ...by(`r${index}`), command: "ls" });
    expect(await exec({ ...by("next"), command: "ls" })).toEqual([
      { kind: "refused", why: "paused" },
    ]);
  });

  it("shows the server's words as given, and draws the command for the window", async () => {
    const { exec, by, asks } = await setUp();
    await exec({
      ...by("r1", { othersWrote: true }),
      command: "echo a‮b",
      reason: "To check the build",
    });
    expect(asks.shown[0]).toMatchObject({
      thread: { id: "t1", title: "Fix the build" },
      actorName: "Ada",
      reason: "To check the build",
      othersWrote: true,
      folderLabel: "app",
      display: { hidden: true },
    });
    expect(asks.shown[0]?.grantIssuedAt).toBe(1_800_000_000_000);
  });

  it("answers no for a grant that isn't one", async () => {
    const { exec, by } = await setUp();
    expect(
      await exec({
        ...by("r1", { grant: { grant: null } as unknown as SignedTurnGrant }),
        command: "ls",
      }),
    ).toEqual([{ kind: "refused", why: "no-grant" }]);
  });

  it("shows nothing for a request taken back or stopped while its path was looked at", async () => {
    const { gate, by, asks, limits, log } = await setUp();
    const events: Array<DeviceExecEvent> = [];
    const cancelled = gate.exec({ ...by("r1"), command: "ls" }, (event) => events.push(event));
    gate.cancel("r1");
    await cancelled;
    const listing = gate.list({ ...by("r2"), path: ".", limit: 10 });
    gate.stopAll("away");
    expect(await listing).toEqual({ kind: "refused", why: "away" });
    expect(events).toEqual([]);
    expect(asks.shown).toHaveLength(0);
    expect(limits.waiting()).toBe(0);
    expect(limits.paused()).toBe(false);
    expect(log.map((entry) => entry.answer)).toEqual(["withdrawn", "away"]);
  });

  it("answers the same for a path that is there and one that isn't once asks are full", async () => {
    const { gate, by, asks, limits } = await setUp();
    asks.answer(() => new Promise(() => undefined));
    for (let index = 0; index < ASKS_WAITING_PER_THREAD; index += 1)
      void gate.exec({ ...by(`held${index}`), command: "ls" }, () => undefined);
    await shownAsks(asks, ASKS_WAITING_PER_THREAD);
    const there = await gate.read({ ...by("there"), path: "README.md", maxBytes: 10 });
    const missing = await gate.read({ ...by("missing"), path: "nope.md", maxBytes: 10 });
    expect(there).toEqual({ kind: "refused", why: "too-many-requests" });
    expect(missing).toEqual(there);
    gate.stopAll("away");
    // With room, a path refused is answered for what it is, and takes one of the server's
    // requests in the window; enough of them and it is refused before the path is looked at.
    await new Promise((later) => setTimeout(later, 20));
    expect(limits.waiting()).toBe(0);
    expect(await gate.read({ ...by("p0"), path: "nope.md", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "not-a-file",
    });
    for (let index = 1 + ASKS_WAITING_PER_THREAD; index < ASKS_PER_WINDOW; index += 1)
      await gate.read({ ...by(`p${index}`), path: "nope.md", maxBytes: 10 });
    expect(await gate.read({ ...by("over"), path: "README.md", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "too-many-requests",
    });
    expect(limits.paused()).toBe(false);
  });

  it("logs only so many requests refused before any ask, and cuts the server's words short", async () => {
    const clock = { at: 0 };
    const { exec, by, log } = await setUp({ elapsed: () => clock.at });
    const long = "x".repeat(4000);
    for (let index = 0; index < 200; index += 1)
      await exec({ ...by(`r${index}`, { actor: { id: "eve", name: "Eve" } }), command: long });
    expect(log).toHaveLength(UNASKED_LOGGED_PER_WINDOW);
    expect(log[0]?.what).toHaveLength(UNASKED_WHAT_MOST + 1);
    expect(log[0]?.answer).toBe("not-for-this-person");
    clock.at += UNASKED_LOG_WINDOW_MS + 1;
    await exec({ ...by("later", { actor: { id: "eve", name: "Eve" } }), command: "ls" });
    expect(log.at(-2)?.what).toBe(
      `${200 - UNASKED_LOGGED_PER_WINDOW} more requests refused before any ask were not logged.`,
    );
    expect(log.at(-1)?.what).toBe("ls");
  });

  it("runs nothing when what was checked before the ask changed during it", async () => {
    const changes: Array<[string, (set: Awaited<ReturnType<typeof setUp>>) => void]> = [
      ["no-grant", ({ grants }) => grants.withdraw({ thread: "t1" })],
      ["outside-folders", ({ state }) => (state.lent = false)],
      ["read-only", ({ state }) => (state.capabilities = ["read"])],
      ["away", ({ state }) => (state.present = false)],
    ];
    for (const [why, change] of changes) {
      const set = await setUp();
      set.asks.answer(async (request) => {
        change(set);
        return { allowed: true, hash: request.hash };
      });
      const events = await set.exec({ ...set.by("r1"), command: "echo ran" });
      expect(events).toEqual([{ kind: "asked" }, { kind: "refused", why }]);
      expect(set.log.map((entry) => entry.answer)).toEqual([why]);
    }
    const set = await setUp();
    set.asks.answer(async (request) => {
      set.state.present = false;
      return { allowed: true, hash: request.hash };
    });
    expect(await set.gate.read({ ...set.by("r2"), path: "README.md", maxBytes: 10 })).toEqual({
      kind: "refused",
      why: "away",
    });
    expect(set.log.map((entry) => entry.answer)).toEqual(["away"]);
  });

  it("counts a window that throws as a refusal, and frees its place", async () => {
    const { exec, by, limits } = await setUp({
      ask: () => {
        throw new Error("no window");
      },
    });
    expect((await exec({ ...by("r1"), command: "ls" })).at(-1)).toEqual({
      kind: "refused",
      why: "not-allowed-by-person",
    });
    expect(limits.waiting()).toBe(0);
  });

  it("takes a joined request back only when every caller has left", async () => {
    const { gate, by, asks } = await setUp();
    asks.answer(() => new Promise(() => undefined));
    const first = new AbortController();
    const second = new AbortController();
    const one = gate.exec({ ...by("r1"), command: "ls" }, () => undefined, first.signal);
    await shownAsks(asks, 1);
    const two = gate.exec({ ...by("r1"), command: "ls" }, () => undefined, second.signal);
    first.abort();
    await new Promise((later) => setTimeout(later, 20));
    expect(asks.withdrawn).toHaveLength(0);
    second.abort();
    await Promise.all([one, two]);
    expect(asks.withdrawn).toHaveLength(1);
    // A read whose only caller leaves is taken back too.
    const leaving = new AbortController();
    const reading = gate.read({ ...by("r2"), path: "README.md", maxBytes: 10 }, leaving.signal);
    await shownAsks(asks, 2);
    leaving.abort();
    expect(await reading).toEqual({ kind: "refused", why: "not-answered" });
  });

  it("refuses reads and listings where nothing may be read, and binds the ask to its id", async () => {
    const { gate, by, asks, state } = await setUp();
    state.capabilities = [];
    expect(await gate.list({ ...by("r1"), path: ".", limit: 10 })).toEqual({
      kind: "refused",
      why: "read-only",
    });
    state.capabilities = ["read"];
    await gate.list({ ...by("r2"), path: "src", limit: 10 });
    expect(asks.shown[0]?.approval.requestId).toBe("r2");
    expect(asks.shown[0]?.approval.target).toBe(join(app, "src"));
  });

  it("reads no more than the size the person was shown", async () => {
    const { gate, by, asks } = await setUp();
    asks.answer(async (request) => {
      await fs.appendFile(join(app, "README.md"), " and more");
      return { allowed: true, hash: request.hash };
    });
    const read = await gate.read({ ...by("r1"), path: "README.md", maxBytes: 100 });
    expect(asks.shown[0]?.size).toBe(5);
    expect(read).toMatchObject({ kind: "read", truncated: true });
    expect(read.kind === "read" && Buffer.from(read.data, "base64").toString()).toBe("hello");
  });
});
