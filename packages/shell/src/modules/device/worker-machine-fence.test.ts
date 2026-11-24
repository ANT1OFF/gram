// The app's fence between a stop and a start of one worker machine name, through the app's own
// call path (`hostedWorkerMachines`): a fake sign-in and a fake server, no network.

import type { HostedDiscovery } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";
import type { TokenKeeper } from "./hosted.ts";
import type { HostedDevice } from "./hosted-device.ts";
import { ANOTHER_ACCOUNT, hostedWorkerMachines } from "./hosted-worker-machines.ts";
import { makeWorkerMachineRelays } from "./serve-machines.ts";
import { devicePrivateKeyFrom, generateDeviceKey } from "./keys.ts";
import { STOP_TOO_LATE, SUPERSEDED } from "./worker-machine-fence.ts";

const ORIGIN = "https://hosted.example.test";
const NAME = "worker-0123456789";
/** The mark of the sign-in the app holds there now (`StoredSignIn.machineMark`). */
const MARK = "mark-ada-0123456789";
const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
const discovery = {
  name: "Example hosted",
  worker_machines_endpoint: `${ORIGIN}/workers`,
  worker_machine_connect: `${ORIGIN.replace("https", "wss")}/workers/relay`,
} as unknown as HostedDiscovery;

/**
 * The app's calls over one signed-in server whose token renewal waits on `renewed`, and whose
 * answers wait on `answer`, recording each request as it goes out.
 */
const setup = (
  gates: { renewed?: Promise<void>; answer?: Promise<void>; stopStatus?: number } = {},
) => {
  const sent: string[] = [];
  const keeper = {
    subject: "ada",
    token: async () => {
      await gates.renewed;
      return {
        ok: true as const,
        token: { accessToken: "at", tokenType: "DPoP" as const, expiresAt: 0, subject: "ada" },
      };
    },
    nonce: {},
    signedOut: () => false,
  } as unknown as TokenKeeper;
  const fetch = async (url: string | URL | Request) => {
    const call = String(url).split("/").at(-1) ?? "";
    sent.push(call);
    await gates.answer;
    return new Response(JSON.stringify({ stopped: true }), {
      status: call === "stop" ? (gates.stopStatus ?? 200) : 200,
      headers: { "content-type": "application/json" },
    });
  };
  const server = {
    origin: ORIGIN,
    discovery,
    key,
    keeper,
    machineMark: MARK,
    limits: { paused: () => false },
  };
  const machines = hostedWorkerMachines({
    servers: () => [server],
    known: (origin) => (origin === ORIGIN ? server : undefined),
    callsOf: () => ({ discovery, keeper, key, fetch: fetch as typeof globalThis.fetch }),
  });
  return { machines, sent };
};

const waitFor = (done: () => boolean) => vi.waitUntil(done, { timeout: 2_000, interval: 2 });

describe("a worker machine's stop, as the app sends it", () => {
  it("is dropped when a newer start of its name comes while it waits to go out", async () => {
    let renew!: () => void;
    const renewed = new Promise<void>((done) => (renew = done));
    const { machines, sent } = setup({ renewed });
    // The stop waits behind a slow token renewal; the server's hold for it runs out meanwhile,
    // and a retry's start of the same name comes.
    const stopping = machines.workerMachineCall(ORIGIN, "stop", { name: NAME });
    const starting = machines.workerMachineCall(ORIGIN, "start", { name: NAME });
    renew();
    expect(await stopping).toEqual({ ok: false, why: SUPERSEDED });
    expect((await starting).ok).toBe(true);
    // Only the start reached the server: the stop never lands on the retry's machine.
    expect(sent).toEqual(["start"]);
  });

  it("holds a start of its name back while it is on its way", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((done) => (answer = done));
    const { machines, sent } = setup({ answer: answered });
    const stopping = machines.workerMachineCall(ORIGIN, "stop", { name: NAME });
    await waitFor(() => sent.includes("stop"));
    let started = false;
    const starting = machines
      .workerMachineCall(ORIGIN, "start", { name: NAME })
      .then(() => (started = true));
    // Nothing but the stop's answer lets it go: however long it waits, it stays back.
    for (let each = 0; each < 50; each += 1) await Promise.resolve();
    expect(sent).toEqual(["stop"]);
    expect(started).toBe(false);
    answer();
    await stopping;
    await starting;
    expect(sent).toEqual(["stop", "start"]);
  });

  it("is a move too: a start of its name waits while the move is on its way", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((done) => (answer = done));
    const { machines, sent } = setup({ answer: answered });
    // The provider ends the run a move names, as a stop does, and starts the next one itself.
    const moving = machines.workerMachineCall(ORIGIN, "move", { name: NAME });
    await waitFor(() => sent.includes("move"));
    const starting = machines.workerMachineCall(ORIGIN, "start", { name: NAME });
    for (let each = 0; each < 50; each += 1) await Promise.resolve();
    expect(sent).toEqual(["move"]);
    answer();
    await moving;
    await starting;
    expect(sent).toEqual(["move", "start"]);
  });

  it("holds a start of its name back after it was answered 503, which settles nothing", async () => {
    const { machines, sent } = setup({ stopStatus: 503 });
    expect(await machines.workerMachineCall(ORIGIN, "stop", { name: NAME })).toMatchObject({
      ok: true,
      status: 503,
    });
    let started = false;
    void machines.workerMachineCall(ORIGIN, "start", { name: NAME }).then(() => (started = true));
    for (let each = 0; each < 50; each += 1) await Promise.resolve();
    // The server's call down may still act on the stop: the start waits out the settling time.
    expect(sent).toEqual(["stop"]);
    expect(started).toBe(false);
  });

  it("is never sent past its sendBy, however long it waited", async () => {
    const { machines, sent } = setup();
    expect(
      await machines.workerMachineCall(ORIGIN, "stop", { name: NAME }, Date.now() - 1),
    ).toEqual({ ok: false, why: STOP_TOO_LATE });
    expect(sent).toEqual([]);
  });
});

describe("a worker machine's call, as the app sends it for one sign-in", () => {
  it("is sent only while the app is signed in there as that person", async () => {
    const { machines, sent } = setup();
    // The server is handed the sign-in's mark, never who the person is.
    const found = machines.workerMachineServer();
    const mine = MARK;
    expect(found).toEqual({
      ok: true,
      server: { origin: ORIGIN, server: "Example hosted", account: mine },
    });
    // Asked for a machine of another sign-in there: nothing goes out.
    for (const call of ["status", "stop", "release"] as const)
      expect(
        await machines.workerMachineCall(
          ORIGIN,
          call,
          { name: NAME },
          undefined,
          "mark-grace-0123456789",
        ),
      ).toEqual(ANOTHER_ACCOUNT);
    expect(sent).toEqual([]);
    expect(
      (await machines.workerMachineCall(ORIGIN, "status", { name: NAME }, undefined, mine)).ok,
    ).toBe(true);
    expect(sent).toEqual(["status"]);
  });
});

describe("a worker machine's relay, under the sign-in it was asked for under", () => {
  it("is neither dialled nor leased under another sign-in there", async () => {
    const { machines, sent } = setup();
    const OLD = "mark-ada-before-0123456789";
    // The app as the relays use it: the real calls over the fake sign-in.
    const opened: string[] = [];
    const relays = makeWorkerMachineRelays({
      watch: false,
      leaseMs: 60_000,
      device: () => machines as unknown as HostedDevice,
      post: () => undefined,
      open: (url) => {
        opened.push(url);
        return { close: () => undefined, send: () => undefined } as never;
      },
    });
    try {
      // Registered under the sign-in before: not carried under this one, nor renewed.
      relays.sync([{ origin: ORIGIN, name: NAME, account: OLD }], true);
      for (let each = 0; each < 50; each += 1) await Promise.resolve();
      expect(opened).toEqual([]);
      expect(sent).toEqual([]);
      expect(machines.workerMachineRelayAllowed(ORIGIN, OLD)).toBe(false);
      expect(await machines.workerMachineRelayLease(ORIGIN, OLD)).toBe(false);
      expect(await machines.workerMachineRelayDial(ORIGIN, NAME, OLD)).toEqual(ANOTHER_ACCOUNT);
      // Its own sign-in's machine is.
      expect(machines.workerMachineRelayAllowed(ORIGIN, MARK)).toBe(true);
    } finally {
      relays.close();
    }
  });
});

describe("a worker machine's relay, as its dial is prepared", () => {
  it("opens nothing when the sign-in changed while the dial was being prepared", async () => {
    const signedIn = { covered: true };
    let prepared!: () => void;
    const preparing = new Promise<void>((done) => (prepared = done));
    const device = {
      workerMachineRelayAllowed: () => signedIn.covered,
      workerMachineRelayLease: async () => signedIn.covered,
      // A token renewal or a nonce keeps the dial waiting.
      workerMachineRelayDial: async () => {
        await preparing;
        return { ok: true, url: `${ORIGIN.replace("https", "wss")}/relay`, headers: {} };
      },
    } as unknown as HostedDevice;
    const opened: string[] = [];
    const relays = makeWorkerMachineRelays({
      watch: false,
      leaseMs: 60_000,
      device: () => device,
      post: () => undefined,
      open: (url) => {
        opened.push(url);
        return { close: () => undefined, send: () => undefined } as never;
      },
    });
    try {
      relays.sync([{ origin: ORIGIN, name: NAME }], true);
      for (let each = 0; each < 10; each += 1) await Promise.resolve();
      // Signed out, or in as someone else, before the dial was ready: nothing opens under it.
      signedIn.covered = false;
      prepared();
      for (let each = 0; each < 50; each += 1) await Promise.resolve();
      expect(opened).toEqual([]);
    } finally {
      relays.close();
    }
  });
});

describe("a sign-in whose mark moved to its organisation's, as the app tells it", () => {
  it("is told for every sign-in, paused or unselected, and its own former mark still answered", async () => {
    const OTHER = "https://other.example.test";
    const OWN = "mark-own-before-0123456789";
    const ORG = "mark-org-now-0123456789";
    const sent: string[] = [];
    const keeper = {
      subject: "ada",
      token: async () => ({
        ok: true as const,
        token: { accessToken: "at", tokenType: "DPoP" as const, expiresAt: 0, subject: "ada" },
      }),
      fresh: async () => ({
        ok: true as const,
        token: { accessToken: "at", tokenType: "DPoP" as const, expiresAt: 0, subject: "ada" },
      }),
      nonce: {},
      signedOut: () => false,
    } as unknown as TokenKeeper;
    const fetch = async (url: string | URL | Request) => {
      sent.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const otherDiscovery = {
      ...discovery,
      worker_machines_endpoint: `${OTHER}/workers`,
      worker_machine_connect: `${OTHER.replace("https", "wss")}/workers/relay`,
    } as unknown as HostedDiscovery;
    // New machines are asked of the first server; the second, paused, was just renewed to its
    // organisation's mark, and its machines and stops are still under its own.
    const paused = { now: true };
    const first = {
      origin: ORIGIN,
      discovery,
      key,
      keeper,
      machineMark: MARK,
      limits: { paused: () => false },
    };
    const second = {
      origin: OTHER,
      discovery: otherDiscovery,
      key,
      keeper,
      machineMark: ORG,
      formerMarks: [OWN],
      limits: { paused: () => paused.now },
    };
    const both = [first, second];
    const machines = hostedWorkerMachines({
      servers: () => both,
      known: (origin) => both.find((each) => each.origin === origin),
      callsOf: (server) => ({
        discovery: server.discovery,
        keeper,
        key,
        fetch: fetch as typeof globalThis.fetch,
      }),
    });
    expect(machines.workerMachineServer()).toMatchObject({ ok: true, server: { origin: ORIGIN } });
    // Every sign-in's marks, the paused one's with what it had before, for the server to move.
    expect(machines.workerMachineMarks()).toEqual([
      { origin: ORIGIN, account: MARK, formerAccounts: [] },
      { origin: OTHER, account: ORG, formerAccounts: [OWN] },
    ]);
    // Until it is moved, what was made under the former mark is still this sign-in's: looked at,
    // stopped and carried, though it is paused and not the one new machines are asked of.
    for (const call of ["status", "stop", "release"] as const)
      expect(
        (await machines.workerMachineCall(OTHER, call, { name: NAME }, undefined, OWN)).ok,
      ).toBe(true);
    expect(sent).toHaveLength(3);
    expect(machines.workerMachineRelayAllowed(OTHER, OWN)).toBe(true);
    expect(await machines.workerMachineRelayLease(OTHER, OWN)).toBe(true);
    // Another sign-in's mark is still another's, and the first's own is never the second's.
    expect(
      await machines.workerMachineCall(OTHER, "status", { name: NAME }, undefined, MARK),
    ).toEqual(ANOTHER_ACCOUNT);
    expect(
      await machines.workerMachineCall(ORIGIN, "status", { name: NAME }, undefined, OWN),
    ).toEqual(ANOTHER_ACCOUNT);
    // A pause still holds back a start.
    expect(
      (await machines.workerMachineCall(OTHER, "start", { name: NAME }, undefined, ORG)).ok,
    ).toBe(false);
  });
});
