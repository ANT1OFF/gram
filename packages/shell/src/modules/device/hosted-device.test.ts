import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browser, fakeServer } from "./hosted-fake.ts";
import {
  type DeviceSecrets,
  type HostedDevice,
  type HostedDeviceOptions,
  makeHostedDevice,
} from "./hosted-device.ts";
import { readDeviceSettings, writeDeviceSettings } from "./settings.ts";

let fake: ReturnType<typeof fakeServer>;
let origin: string;
let base: string;
let dataDir: string;
let project: string;
let clock = 0;
const devices: Array<HostedDevice> = [];
/** Every connection a device dialled. */
const dials: Array<string> = [];

/** Secrets as the app's vault keeps them: without a real keyring, nothing is kept. */
const secretsIn = (store: Map<string, string>, strong = true): DeviceSecrets => ({
  strong: async () => strong,
  get: async (name) => (strong ? store.get(name) : undefined),
  set: async (name, value) => {
    if (!strong) throw new Error("No keyring: nothing is kept.");
    store.set(name, value);
  },
  remove: async (name) => {
    store.delete(name);
  },
});

const setUp = async (
  more: Partial<HostedDeviceOptions> = {},
  store = new Map<string, string>(),
) => {
  const confirmed: Array<string> = [];
  const present = { now: true, listeners: new Set<() => void>() };
  const device = await makeHostedDevice({
    dataDir,
    secrets: secretsIn(store),
    fetch,
    openBrowser: browser,
    confirmServer: async (server) => {
      confirmed.push(`${server.origin} ${server.name}`);
      return true;
    },
    ask: () => new Promise(() => undefined),
    presence: {
      present: () => present.now,
      known: () => true,
      onChange: (changed) => {
        present.listeners.add(changed);
        return () => present.listeners.delete(changed);
      },
    },
    bounds: { home: join(base, "home"), ownFolders: [dataDir], agentHomes: [] },
    environment: () => ({ env: {}, secrets: [] }),
    machineName: "Ada's laptop",
    platform: "linux",
    now: () => clock,
    elapsed: () => clock,
    // The dial never opens: these tests are about what the person decided, not the connection.
    connect: (url) => {
      dials.push(url.href);
      return Effect.never;
    },
    ...more,
  });
  devices.push(device);
  return { device, store, confirmed, present };
};

beforeEach(async () => {
  fake = fakeServer();
  origin = await fake.start();
  clock = 1_000_000;
  dials.length = 0;
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-hosted-device-")));
  dataDir = join(base, "data");
  project = join(base, "code", "app");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(join(base, "home"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
});
afterEach(async () => {
  for (const device of devices.splice(0)) await device.close();
  fake.server.closeAllConnections();
  fake.server.close();
  await fs.rm(base, { recursive: true, force: true });
});

describe("this machine as a personal device", () => {
  it("signs in once the person accepts the server, registers, and lists its workspaces", async () => {
    const { device, store, confirmed } = await setUp();
    expect(await device.signIn(origin)).toEqual({ ok: true });
    expect(confirmed).toEqual([`${origin} Example`]);
    expect(fake.state.names).toEqual(["Ada's laptop"]);
    expect(fake.state.registeredKey).toBeDefined();
    expect([...store.keys()].toSorted()).toEqual([
      "device-files",
      `device-key ${origin}`,
      `device-sign-in ${origin}`,
    ]);
    expect(device.state()).toEqual({
      servers: [
        {
          origin,
          name: "Example",
          signedIn: true,
          paused: false,
          workspaces: [
            {
              id: "w1",
              name: "Platform",
              organisation: "Example",
              policy: "on",
              lending: "off",
              readOnly: false,
              folders: [],
              connected: false,
            },
          ],
        },
      ],
    });
    expect(await device.signIn(origin)).toMatchObject({ ok: false });
  });

  it("signs in to nothing the person didn't accept", async () => {
    const { device, store } = await setUp({ confirmServer: async () => false });
    expect(await device.signIn(origin)).toEqual({ ok: false, why: "Not signed in." });
    expect(device.state().servers).toEqual([]);
    expect(store.has(`device-sign-in ${origin}`)).toBe(false);
    expect(fake.state.registeredKey).toBeUndefined();
  });

  it("lends only folders that may be lent, and keeps them for a resume after a restart", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    expect(
      await first.device.lend(origin, "w1", {
        folders: [{ path: join(base, "home"), label: "home" }],
        readOnly: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await first.device.lend(origin, "nope", {
        folders: [{ path: project, label: "app" }],
        readOnly: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await first.device.lend(origin, "w1", {
        folders: [{ path: project, label: "app" }],
        readOnly: false,
      }),
    ).toEqual({ ok: true });
    expect(first.device.state().servers[0]?.workspaces[0]).toMatchObject({
      lending: "on",
      folders: [{ label: "app", path: project }],
    });
    await first.device.close();

    // Started again with the same keychain: offered to resume, never on by itself.
    const again = await setUp({}, first.store);
    await waitFor(() => (again.device.state().servers[0]?.workspaces.length ?? 0) > 0);
    expect(again.device.state().servers[0]?.workspaces[0]).toMatchObject({
      lending: "resume",
      folders: [{ label: "app", path: project }],
    });
    expect(await again.device.resume(origin, "w1")).toEqual({ ok: true });
    expect(again.device.state().servers[0]?.workspaces[0]?.lending).toBe("on");
    await again.device.stop(origin, "w1");
    expect(again.device.state().servers[0]?.workspaces[0]).toMatchObject({
      lending: "off",
      folders: [],
    });
  });

  it("won't resume a folder that was swapped for another while the app was closed", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    await fs.rename(project, `${project}-old`);
    await fs.mkdir(project);
    const again = await setUp({}, first.store);
    await waitFor(() => (again.device.state().servers[0]?.workspaces.length ?? 0) > 0);
    expect(await again.device.resume(origin, "w1")).toMatchObject({ ok: false });
    expect(again.device.state().servers[0]?.workspaces[0]?.lending).toBe("resume");
  });

  it("offers no lending without a real keyring, and none from settings that were edited", async () => {
    const weak = await makeHostedDevice({
      ...(await optionsFor()),
      secrets: secretsIn(new Map(), false),
    });
    devices.push(weak);
    expect(weak.state().unavailable).toBe("no-keyring");
    // Signed in for the session, and nothing kept: the vault would refuse it.
    expect(await weak.signIn(origin)).toEqual({ ok: true });
    expect(weak.state().servers[0]?.signedIn).toBe(true);

    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    const file = join(dataDir, "device-settings.json");
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(file, text.replace("app", "ap2"));
    const edited = await setUp({}, first.store);
    expect(edited.device.state().unavailable).toBe("settings-edited");
    expect(edited.device.state().servers).toEqual([]);
    expect(
      await edited.device.lend(origin, "w1", {
        folders: [{ path: project, label: "app" }],
        readOnly: false,
      }),
    ).toMatchObject({ ok: false });
  });

  it("keeps a pause across a restart until the person lifts it", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.close();
    // Paused as the limits pause it, and saved so.
    const file = join(dataDir, "device-settings.json");
    const key = createHmac(
      "sha256",
      Buffer.from(first.store.get("device-files") ?? "", "base64url"),
    )
      .update("gram-device-settings-v1")
      .digest();
    const read = await readDeviceSettings(file, key);
    if (!read.ok) throw new Error("unreadable");
    await writeDeviceSettings(file, key, {
      ...read.settings,
      servers: read.settings.servers.map((server) => ({ ...server, paused: true })),
    });
    const second = await setUp({}, first.store);
    expect(second.device.state().servers[0]?.paused).toBe(true);
    await second.device.liftPause(origin);
    expect(second.device.state().servers[0]?.paused).toBe(false);
    await second.device.close();
    const third = await setUp({}, first.store);
    expect(third.device.state().servers[0]?.paused).toBe(false);
  });

  it("takes back every turn's grant when the person steps away", async () => {
    const { device, present } = await setUp();
    await device.signIn(origin);
    await device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    const grants = device.grants(origin);
    grants?.mint({ origin, workspace: "w1", thread: "t1" });
    expect(grants?.size()).toBe(1);
    present.now = false;
    for (const changed of present.listeners) changed();
    expect(grants?.size()).toBe(0);
  });

  it("signs out: lending stops, the server forgets the device, and the keychain is cleared", async () => {
    const { device, store } = await setUp();
    await device.signIn(origin);
    await device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await device.signOut(origin);
    expect(device.state().servers).toEqual([]);
    expect(fake.state.forgotten).toHaveLength(1);
    expect([...store.keys()]).toEqual(["device-files"]);
    expect(device.grants(origin)).toBeUndefined();
  });

  it("lends nothing the settings can't keep, and the next save still works", async () => {
    const { device, present } = await setUp();
    await device.signIn(origin);
    expect(
      await device.lend(origin, "w1", {
        folders: [{ path: project, label: "x".repeat(200) }],
        readOnly: false,
      }),
    ).toMatchObject({ ok: false });
    expect(device.state().servers[0]?.workspaces[0]?.lending).toBe("off");
    present.now = false;
    for (const changed of present.listeners) changed();
    present.now = true;
    for (const changed of present.listeners) changed();
    await settle();
    expect(dials).toEqual([]);
    expect(
      await device.lend(origin, "w1", {
        folders: [{ path: project, label: "app" }],
        readOnly: false,
      }),
    ).toEqual({ ok: true });
  });

  it("keeps a server it couldn't reach at start, pause and folders, until it can", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    const file = join(dataDir, "device-settings.json");
    const key = settingsKey(first.store);
    const read = await readDeviceSettings(file, key);
    if (!read.ok) throw new Error("unreadable");
    await writeDeviceSettings(file, key, {
      ...read.settings,
      servers: read.settings.servers.map((server) => ({ ...server, paused: true })),
    });

    const other = fakeServer();
    const otherOrigin = await other.start();
    let online = false;
    const flaky: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!online && url.startsWith(origin)) throw new TypeError("offline");
      return fetch(input, init);
    };
    try {
      const second = await setUp({ fetch: flaky }, first.store);
      expect(second.device.state().servers[0]).toMatchObject({
        origin,
        signedIn: false,
        paused: true,
        problem: expect.any(String),
      });
      // Signing in elsewhere doesn't erase it.
      expect(await second.device.signIn(otherOrigin)).toEqual({ ok: true });
      const after = await readDeviceSettings(file, key);
      if (!after.ok) throw new Error("unreadable");
      expect(after.settings.servers.find((server) => server.origin === origin)).toMatchObject({
        paused: true,
        workspaces: [{ id: "w1" }],
      });
      // Back online, trying again brings it back as it was.
      online = true;
      expect(await second.device.refresh(origin)).toEqual({ ok: true });
      const restored = () =>
        second.device.state().servers.find((server) => server.origin === origin);
      await waitFor(() => (restored()?.workspaces.length ?? 0) > 0);
      expect(restored()).toMatchObject({ signedIn: true, paused: true });
      expect(restored()?.workspaces[0]?.lending).toBe("resume");
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  it("signs in to one server once at a time", async () => {
    let opened = 0;
    const { device } = await setUp({
      openBrowser: async (url) => {
        opened += 1;
        await new Promise((later) => setTimeout(later, 50));
        return browser(url);
      },
    });
    const both = await Promise.all([device.signIn(origin), device.signIn(origin)]);
    expect(both.filter((done) => done.ok)).toHaveLength(1);
    expect(opened).toBe(1);
    expect(fake.state.names).toHaveLength(1);
    expect(device.state().servers).toHaveLength(1);
  });

  it("leaves no key behind from a sign-in that didn't finish", async () => {
    fake.state.lieAboutId = true;
    const { device, store } = await setUp();
    expect(await device.signIn(origin)).toMatchObject({ ok: false });
    expect([...store.keys()]).toEqual(["device-files"]);
    fake.state.lieAboutId = false;
    const stopped = new AbortController();
    const second = await setUp({ openBrowser: async () => stopped.abort() });
    expect(await second.device.signIn(origin, stopped.signal)).toMatchObject({ ok: false });
    expect([...second.store.keys()]).toEqual(["device-files"]);
  });

  it("lets the person sign in again after the server ends the sign-in", async () => {
    const { device, store } = await setUp();
    await device.signIn(origin);
    await device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    fake.state.refresh.clear();
    clock += 2 * 60 * 60_000;
    expect(await device.refresh(origin)).toMatchObject({ ok: false });
    await settle();
    expect(device.state().servers[0]).toMatchObject({ signedIn: false });
    expect(store.has(`device-sign-in ${origin}`)).toBe(false);
    expect(device.grants(origin)?.size()).toBe(0);
    expect(await device.signIn(origin)).toEqual({ ok: true });
    expect(device.state().servers).toHaveLength(1);
    expect(device.state().servers[0]?.signedIn).toBe(true);
    // What was lent waits to be resumed, never on by itself.
    expect(device.state().servers[0]?.workspaces[0]?.lending).toBe("resume");
  });

  it("resumes nothing while what the organisation allows isn't known", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    fake.state.workspacesStatus = 500;
    dials.length = 0;
    const again = await setUp({}, first.store);
    await waitFor(() => again.device.state().servers[0]?.problem !== undefined);
    expect(await again.device.resume(origin, "w1")).toMatchObject({ ok: false });
    await settle();
    expect(dials).toEqual([]);
  });

  it("won't resume a folder that was deleted and made again", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    await fs.rm(project, { recursive: true });
    await fs.mkdir(project);
    const again = await setUp({}, first.store);
    await waitFor(() => (again.device.state().servers[0]?.workspaces.length ?? 0) > 0);
    expect(await again.device.resume(origin, "w1")).toMatchObject({ ok: false });
  });

  it("finishes no sign-in once it is closed", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { device, store } = await setUp({
      confirmServer: async () => {
        await held;
        return true;
      },
    });
    const signing = device.signIn(origin);
    await settle();
    await device.close();
    release();
    expect(await signing).toMatchObject({ ok: false });
    expect(device.state().servers).toEqual([]);
    expect([...store.keys()]).toEqual(["device-files"]);
    expect(fake.state.names).toEqual([]);
  });

  it("starts afresh from edited settings only when the person chooses", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.close();
    const file = join(dataDir, "device-settings.json");
    await fs.writeFile(file, "{}");
    const edited = await setUp({}, first.store);
    expect(edited.device.state().unavailable).toBe("settings-edited");
    expect(await edited.device.startAfresh()).toEqual({ ok: true });
    expect(edited.device.state().unavailable).toBeUndefined();
    const aside = (await fs.readdir(dataDir)).filter((name) => name.includes(".edited-"));
    expect(aside.some((name) => name.startsWith("device-settings.json."))).toBe(true);
    expect((await readDeviceSettings(file, settingsKey(first.store))).ok).toBe(true);
  });

  it("keeps the sign-in it had when signing in there again fails", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.close();
    let online = false;
    const flaky = offlineUnless(() => online, origin);
    const second = await setUp({ fetch: flaky }, first.store);
    expect(second.device.state().servers[0]?.signedIn).toBe(false);
    online = true;
    fake.state.lieAboutId = true;
    expect(await second.device.signIn(origin)).toMatchObject({ ok: false });
    fake.state.lieAboutId = false;
    expect(first.store.has(`device-sign-in ${origin}`)).toBe(true);
    expect(await second.device.refresh(origin)).toEqual({ ok: true });
  });

  it("brings a server back by one way at a time, and the sign-in keeps what was lent", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    let online = false;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const second = await setUp(
      {
        fetch: offlineUnless(() => online, origin),
        openBrowser: async (url) => {
          await held;
          return browser(url);
        },
      },
      first.store,
    );
    online = true;
    const signing = second.device.signIn(origin);
    await settle();
    expect(await second.device.refresh(origin)).toMatchObject({ ok: false });
    release();
    expect(await signing).toEqual({ ok: true });
    expect(second.device.state().servers).toHaveLength(1);
    expect(second.device.state().servers[0]?.workspaces[0]?.lending).toBe("resume");
    await second.device.signOut(origin);
    expect(second.device.state().servers).toEqual([]);
  });

  it("keeps at most sixteen servers, even signing in to two at once", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.signOut(origin);
    await first.device.close();
    const file = join(dataDir, "device-settings.json");
    const key = settingsKey(first.store);
    // Fifteen servers saved that can't be reached: each is kept as saved.
    await writeDeviceSettings(file, key, {
      v: 1,
      servers: Array.from({ length: 15 }, (_, i) => ({
        origin: `https://gone-${i}.invalid`,
        paused: false,
        workspaces: [],
      })),
    });
    const other = fakeServer();
    const otherOrigin = await other.start();
    try {
      const second = await setUp({}, first.store);
      expect(second.device.state().servers).toHaveLength(15);
      const both = await Promise.all([
        second.device.signIn(origin),
        second.device.signIn(otherOrigin),
      ]);
      expect(both.filter((done) => done.ok)).toHaveLength(1);
      expect(second.device.state().servers).toHaveLength(16);
      const after = await readDeviceSettings(file, key);
      expect(after.ok && after.settings.servers.length).toBe(16);
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  it("dials nothing for a lend until the settings keep it", async () => {
    const { device, present } = await setUp();
    await device.signIn(origin);
    // The settings can't be written: a folder stands where the file goes.
    const file = join(dataDir, "device-settings.json");
    await fs.rm(file, { force: true });
    await fs.mkdir(join(file, "block"), { recursive: true });
    const done = { now: false };
    const lending = device
      .lend(origin, "w1", { folders: [{ path: project, label: "app" }], readOnly: false })
      .finally(() => {
        done.now = true;
      });
    while (!done.now) {
      for (const changed of present.listeners) changed();
      await new Promise((later) => setImmediate(later));
    }
    expect(await lending).toMatchObject({ ok: false });
    await settle();
    expect(dials).toEqual([]);
    expect(device.state().servers[0]?.workspaces[0]?.lending).toBe("off");
  });

  it("keeps every saved server in the settings while start is still finding them", async () => {
    const other = fakeServer();
    const otherOrigin = await other.start();
    try {
      const first = await setUp();
      await first.device.signIn(origin);
      await first.device.signIn(otherOrigin);
      for (const each of [origin, otherOrigin])
        await first.device.lend(each, "w1", {
          folders: [{ path: project, label: "app" }],
          readOnly: false,
        });
      await first.device.close();
      const file = join(dataDir, "device-settings.json");
      const key = settingsKey(first.store);
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const slow: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(otherOrigin) && url.includes("well-known")) await held;
        return fetch(input, init);
      };
      const starting = setUp({ fetch: slow }, first.store);
      // The first server's workspace is let go meanwhile, which saves.
      fake.state.workspaces = [];
      await settle();
      await settle();
      const mid = await readDeviceSettings(file, key);
      expect(mid.ok && mid.settings.servers.map((server) => server.origin).toSorted()).toEqual(
        [origin, otherOrigin].toSorted(),
      );
      // The save did happen: the first server's workspace is gone from it.
      expect(
        mid.ok && mid.settings.servers.find((server) => server.origin === origin)?.workspaces,
      ).toEqual([]);
      release();
      await starting;
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  it("counts a server signed in to again once toward the limit", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.close();
    const file = join(dataDir, "device-settings.json");
    const key = settingsKey(first.store);
    // Fourteen kept that can't be reached, and this one with its sign-in gone: fifteen.
    await writeDeviceSettings(file, key, {
      v: 1,
      servers: [
        ...Array.from({ length: 14 }, (_, i) => ({
          origin: `https://gone-${i}.invalid`,
          paused: false,
          workspaces: [],
        })),
        { origin, paused: false, workspaces: [] },
      ],
    });
    first.store.delete(`device-sign-in ${origin}`);
    const other = fakeServer();
    const otherOrigin = await other.start();
    try {
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const second = await setUp(
        {
          openBrowser: async (url) => {
            if (url.startsWith(origin)) await held;
            return browser(url);
          },
        },
        first.store,
      );
      expect(second.device.state().servers).toHaveLength(15);
      const again = second.device.signIn(origin);
      await settle();
      expect(await second.device.signIn(otherOrigin)).toEqual({ ok: true });
      release();
      expect(await again).toEqual({ ok: true });
      expect(second.device.state().servers).toHaveLength(16);
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  it("brings back no server the person signed out of while it was being found", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.close();
    let online = false;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const slow: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!online && url.startsWith(origin)) throw new TypeError("offline");
      if (url.startsWith(origin) && url.includes("well-known")) await held;
      return fetch(input, init);
    };
    const second = await setUp({ fetch: slow }, first.store);
    online = true;
    const trying = second.device.refresh(origin);
    await settle();
    await second.device.signOut(origin);
    release();
    expect(await trying).toMatchObject({ ok: false });
    expect(second.device.state().servers).toEqual([]);
  });

  it("resumes only the folders shown, and keeps reads only when it said so", async () => {
    const first = await setUp();
    await first.device.signIn(origin);
    await first.device.lend(origin, "w1", {
      folders: [{ path: project, label: "app" }],
      readOnly: false,
    });
    await first.device.close();
    const again = await setUp({}, first.store);
    await waitFor(() => (again.device.state().servers[0]?.workspaces.length ?? 0) > 0);
    const lent = again.device.state().servers[0]?.workspaces[0];
    const ids = lent?.folders.map((folder) => folder.id) ?? [];
    expect(
      await again.device.resume(origin, "w1", { folders: ["f-0000000000000000"], readOnly: false }),
    ).toMatchObject({ ok: false });
    expect(await again.device.resume(origin, "w1", { folders: ids, readOnly: true })).toEqual({
      ok: true,
    });
    expect(again.device.state().servers[0]?.workspaces[0]).toMatchObject({
      lending: "on",
      readOnly: true,
    });
  });

  it("lends no folder whose path now leads elsewhere", async () => {
    const { device } = await setUp();
    await device.signIn(origin);
    const link = join(base, "code", "link");
    await fs.symlink(project, link);
    expect(
      await device.lend(origin, "w1", { folders: [{ path: link, label: "app" }], readOnly: false }),
    ).toMatchObject({ ok: false });
  });
});

const optionsFor = async (): Promise<HostedDeviceOptions> => ({
  dataDir,
  secrets: secretsIn(new Map()),
  fetch,
  openBrowser: browser,
  confirmServer: async () => true,
  ask: () => new Promise(() => undefined),
  presence: { present: () => true, known: () => true, onChange: () => () => undefined },
  bounds: { home: join(base, "home"), ownFolders: [dataDir], agentHomes: [] },
  environment: () => ({ env: {}, secrets: [] }),
  machineName: "laptop",
  platform: "linux",
  now: () => clock,
  elapsed: () => clock,
  connect: () => Effect.never,
});

const settingsKey = (store: Map<string, string>) =>
  createHmac("sha256", Buffer.from(store.get("device-files") ?? "", "base64url"))
    .update("gram-device-settings-v1")
    .digest();

/** A fetch that can't reach one origin until `online` says so. */
const offlineUnless =
  (online: () => boolean, unreachable: string): typeof fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!online() && url.startsWith(unreachable)) throw new TypeError("offline");
    return fetch(input, init);
  };

const settle = () => new Promise((later) => setTimeout(later, 30));

const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i += 1) await new Promise((later) => setTimeout(later, 2));
};
