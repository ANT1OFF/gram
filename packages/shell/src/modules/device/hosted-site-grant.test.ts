import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browser, fakeServer } from "./hosted-fake.ts";
import { type HostedDevice, makeHostedDevice } from "./hosted-device.ts";

// The server's site, open in its window, gets a grant for a message the person sends only while
// this machine lends to that workspace and is connected to it: a grant there lets the turn ask
// this machine, so none is signed for a workspace the person didn't lend to, or once they stop.

let fake: ReturnType<typeof fakeServer>;
let origin: string;
let base: string;
const devices: Array<HostedDevice> = [];

const pipe = () => new TransformStream<Uint8Array, Uint8Array>();

/** A dial that opens: the device's end of a pipe nobody answers. */
const opens = () =>
  Effect.gen(function* () {
    const there = pipe();
    const back = pipe();
    return yield* Socket.fromTransformStream(
      Effect.succeed({ readable: there.readable, writable: back.writable }),
    );
  });

const setUp = async () => {
  const changes = new Set<() => void>();
  const kept = new Map<string, string>();
  const device = await makeHostedDevice({
    dataDir: join(base, "data"),
    secrets: {
      strong: async () => true,
      get: async (name) => kept.get(name),
      set: async (name, value) => {
        kept.set(name, value);
      },
      remove: async (name) => {
        kept.delete(name);
      },
    },
    fetch,
    openBrowser: browser,
    confirmServer: async () => true,
    ask: () => new Promise(() => undefined),
    presence: { present: () => true, known: () => true, onChange: () => () => undefined },
    bounds: { home: join(base, "home"), ownFolders: [join(base, "data")], agentHomes: [] },
    environment: () => ({ env: {}, secrets: [] }),
    machineName: "Ada's laptop",
    platform: "linux",
    now: () => Date.now(),
    elapsed: () => performance.now(),
    connect: () => opens(),
    changed: () => {
      for (const changed of changes) changed();
    },
  });
  devices.push(device);
  const waitFor = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      const changed = () => {
        if (!done()) return;
        changes.delete(changed);
        resolve();
      };
      changes.add(changed);
      changed();
    });
  return { device, waitFor };
};

beforeEach(async () => {
  fake = fakeServer();
  origin = await fake.start();
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-hosted-site-")));
  for (const dir of ["data", "home", "code/app"])
    await fs.mkdir(join(base, dir), { recursive: true });
});
afterEach(async () => {
  for (const device of devices.splice(0)) await device.close();
  fake.server.closeAllConnections();
  fake.server.close();
  await fs.rm(base, { recursive: true, force: true });
});

describe("a turn grant for the server's site", () => {
  it("is signed only while this machine lends to the workspace and is connected there", async () => {
    const { device, waitFor } = await setUp();
    expect(device.turnGrant(origin, "w1", "t1")).toBeUndefined();
    await device.signIn(origin);
    expect(device.sitePage(origin, "w1")).toBe(`${origin}/w/w1`);
    expect(device.sitePage(origin, "w-other")).toBeUndefined();
    expect(device.turnGrant(origin, "w1", "t1")).toBeUndefined();

    await device.lend(origin, "w1", {
      folders: [{ path: join(base, "code/app"), label: "app" }],
      readOnly: false,
    });
    await waitFor(() => device.state().servers[0]?.workspaces[0]?.connected === true);
    expect(device.turnGrant(origin, "w-other", "t1")).toBeUndefined();
    const grant = device.turnGrant(origin, "w1", "t1");
    expect(grant?.grant).toMatchObject({ origin, workspace: "w1", thread: "t1" });
    if (grant === undefined) throw new Error("no grant");
    expect(device.grants(origin)?.holds(grant, { origin, workspace: "w1", thread: "t1" })).toBe(
      true,
    );

    await device.stop(origin, "w1");
    expect(device.turnGrant(origin, "w1", "t1")).toBeUndefined();
  });
});
