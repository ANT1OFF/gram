// One sign-in's worker machines and the stops owed for them, kept apart from another sign-in's at
// the same hosted server: every call carries the sign-in's mark, and nothing made under one is
// settled or let go of by another. A fake app over the port, no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { generateHostKey } from "../host/machine-keys.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ACCOUNT, fakeApp, NAME, ORIGIN, SERVER } from "./signed-in-fixtures.ts";
import {
  bridgeWorkerMachines,
  claimedHere,
  fileOwedStops,
  memoryOwedStops,
  settleOwedStops,
  SignedInWorkers,
  SignedInWorkersLive,
  signedInSource,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";

/** Another sign-in at the same server: the same person in another organisation, say. */
const OTHER = "account-grace-0123456789";

const unregistered = {
  list: () => [],
  remove: () => false,
  machines: {
    provision: () => {
      throw new Error("not registered here");
    },
  },
};

/**
 * The app as it is signed in at the server as `current`: what is asked under another sign-in's
 * mark isn't sent, and what is sent is answered `answer`. Records each call and its mark.
 */
const appSignedInAs = (
  current: string,
  answer: (call: string) => { readonly status: number; readonly body: unknown },
) => {
  const sent: Array<{ readonly call: string; readonly account: string | undefined }> = [];
  const base = bridgeWorkerMachines(fakeApp({ answer: ({ call }) => answer(call) }).port);
  const port: WorkerMachinePortShape = {
    ...base,
    call: (origin, call, body, options) => {
      if (options?.account !== undefined && options.account !== current)
        return Effect.succeed({ ok: false as const, why: "signed in as someone else" });
      sent.push({ call, account: options?.account });
      return base.call(origin, call, body, options);
    },
  };
  return { port, sent };
};

describe("a sign-in's worker machines", () => {
  it.effect("start under the sign-in they were asked for under, and nowhere else", () =>
    Effect.gen(function* () {
      // Asked for under the first sign-in; the app is signed in as someone else by the time
      // the start would go.
      const app = appSignedInAs(OTHER, (call) =>
        call === "start" ? { status: 202, body: {} } : { status: 200, body: {} },
      );
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port: app.port,
        hosts: unregistered,
        owed,
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
      // Nothing reached the server for another sign-in to own: refused, and its owing kept.
      expect(app.sent).toEqual([]);
      expect(started.kind).toBe("refused");
      expect(owed.list().map((each) => [each.name, each.account])).toEqual([[NAME, ACCOUNT]]);
    }),
  );

  it.effect("are asked for, a released one's take-back too, with the sign-in's mark", () =>
    Effect.gen(function* () {
      let released = true;
      const app = appSignedInAs(ACCOUNT, (call) => {
        if (call === "release") released = false;
        return call === "start" && released
          ? { status: 409, body: { code: "released" } }
          : { status: call === "start" ? 202 : 200, body: { known: true } };
      });
      const source = signedInSource(SERVER, { port: app.port, hosts: unregistered });
      expect((yield* source.start({ name: NAME, orchestrator: "o", title: "Again" })).kind).toBe(
        "started",
      );
      expect(app.sent).toEqual([
        { call: "start", account: ACCOUNT },
        { call: "release", account: ACCOUNT },
        { call: "start", account: ACCOUNT },
      ]);
    }),
  );
});

describe("a machine registered under another sign-in", () => {
  it.live("is neither reused nor stopped by a same-request retry under a new sign-in", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      // Registered under the person's sign-in before they signed in again: frozen for the new.
      const key = generateHostKey();
      hosts.machines.provision({
        name: NAME,
        publicKey: key.publicKey,
        platform: "linux",
        onDemand: "worker",
        via: ORIGIN,
        viaAccount: OTHER,
      });
      // The server would hand the same name's old disk back, and a stop of it delete it.
      const app = appSignedInAs(ACCOUNT, (call) =>
        call === "status"
          ? { status: 200, body: { phase: "running", publicKey: key.publicKey } }
          : { status: call === "start" ? 202 : 200, body: { stopped: true } },
      );
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port: app.port,
        hosts,
        owed,
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      // A retry of the same request: the same name. Refused in words, with nothing sent.
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
      expect(started).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("another sign-in"),
      });
      expect(started).not.toHaveProperty("unknown");
      // Nor does any give-back of the name stop it.
      yield* source.abandon(NAME);
      yield* source.abandon(NAME, { unsettled: true });
      expect(app.sent).toEqual([]);
      expect(owed.list()).toEqual([]);
      expect(hosts.list().map((each) => [each.name, each.viaAccount])).toEqual([[NAME, OTHER]]);
    }),
  );
});

describe("what a server offers a sign-in", () => {
  it.effect("is kept for that sign-in alone, never read for another's", () =>
    Effect.gen(function* () {
      const asked: Array<string | undefined> = [];
      const base = bridgeWorkerMachines(
        fakeApp({
          answer: () => ({ status: 200, body: { models: [{ agent: "claude", id: "opus" }] } }),
        }).port,
      );
      const port: WorkerMachinePortShape = {
        ...base,
        call: (origin, call, body, options) => {
          asked.push(options?.account);
          return base.call(origin, call, body, options);
        },
      };
      const offered = new Map();
      yield* signedInSource(SERVER, { port, hosts: unregistered, offered }).models;
      // Kept a while for the same sign-in; another's is asked under its own.
      yield* signedInSource(SERVER, { port, hosts: unregistered, offered }).models;
      yield* signedInSource({ ...SERVER, account: OTHER }, { port, hosts: unregistered, offered })
        .models;
      expect(asked).toEqual([ACCOUNT, OTHER]);
    }),
  );
});

describe("a sign-in whose mark became its organisation's", () => {
  it.live("takes its own machines and stops to the new mark, and no other sign-in's", () =>
    Effect.gen(function* () {
      const FORMER = "mark-own-before-0123456789";
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      for (const [name, viaAccount] of [
        [NAME, FORMER],
        ["worker-abcdef0123", OTHER],
      ] as const)
        hosts.machines.provision({
          name,
          publicKey: generateHostKey().publicKey,
          platform: "linux",
          onDemand: "worker",
          via: ORIGIN,
          viaAccount,
        });
      // The app says this sign-in's mark is now its organisation's, and what it had before.
      const app = fakeApp({
        server: { server: { ...SERVER, formerAccounts: [FORMER] } },
        answer: () => ({ status: 200, body: {} }),
      });
      const context = yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      yield* Effect.gen(function* () {
        const workers = yield* SignedInWorkers;
        yield* workers.source;
      }).pipe(Effect.provide(context));
      // Moved before any source asks under it; another sign-in's is left as it is.
      expect(hosts.list().map((each) => [each.name, each.viaAccount])).toEqual([
        [NAME, ACCOUNT],
        ["worker-abcdef0123", OTHER],
      ]);
      // As are the stops owed.
      const owed = memoryOwedStops();
      owed.add({ origin: ORIGIN, name: NAME, since: 0, account: FORMER });
      owed.add({ origin: ORIGIN, name: NAME, since: 1, account: OTHER });
      owed.remark(ORIGIN, FORMER, ACCOUNT);
      expect(owed.list().map((each) => each.account)).toEqual([ACCOUNT, OTHER]);
    }).pipe(Effect.scoped),
  );
});

/** Another hosted server this computer is signed in to, besides the one new machines come from. */
const SECOND = "https://second.example.test";
/** The second's sign-in: its own mark before a renewal named its organisation, and after. */
const OWN = "mark-own-before-0123456789";
const ORG = "mark-org-now-0123456789";
/** A machine a stop is owed for, no longer registered here. */
const GONE = "worker-gone000001";
/** The server, busy: nothing owed settles while a test looks at what is owed. */
const BUSY = () => ({ status: 503, body: {} });

/** A data folder with these stops owed on disk, and a way to read back what is owed there. */
const stopsOnDisk = (owed: ReadonlyArray<Record<string, unknown>>) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-marks-"));
  mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
  const path = join(dir, "remote-access", "worker-machine-stops.json");
  writeFileSync(path, JSON.stringify({ version: 1, owed }), { mode: 0o600 });
  return {
    dir,
    owedAccounts: () =>
      (JSON.parse(readFileSync(path, "utf8")) as { owed: Array<{ account?: string }> }).owed.map(
        (each) => each.account,
      ),
  };
};

/** Waits for `done`, a few milliseconds at a time, for at most two seconds. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let each = 0; each < 400 && !done(); each += 1) yield* Effect.sleep("5 millis");
    expect(done()).toBe(true);
  });

const workersOver = (
  app: ReturnType<typeof fakeApp>,
  hosts: RemoteHosts["Service"],
  dataDir: string,
) =>
  Layer.build(
    SignedInWorkersLive.pipe(
      Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
      Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
      Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir })),
    ),
  );

const provisionOn = (hosts: RemoteHosts["Service"], name: string, viaAccount: string) =>
  hosts.machines.provision({
    name,
    publicKey: generateHostKey().publicKey,
    platform: "linux",
    onDemand: "worker",
    via: SECOND,
    viaAccount,
  });

describe("a sign-in that isn't the one new machines are asked of", () => {
  it.live("has its machines and stops moved to its new mark as soon as the app says so", () =>
    Effect.gen(function* () {
      const disk = stopsOnDisk([
        { origin: SECOND, name: GONE, since: 0, account: OWN },
        { origin: SECOND, name: "worker-gone000002", since: 1, account: OTHER },
      ]);
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(disk.dir, { recursive: true })));
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionOn(hosts, NAME, OWN);
      provisionOn(hosts, "worker-abcdef0123", OTHER);
      // New machines are asked of the first server, whose sign-in has no former marks. The
      // second's, paused or not chosen, is told only among every sign-in's marks.
      const marks: Array<{ origin: string; account: string; formerAccounts: string[] }> = [
        { origin: ORIGIN, account: ACCOUNT, formerAccounts: [] },
        { origin: SECOND, account: OWN, formerAccounts: [] },
      ];
      const app = fakeApp({ marks: () => marks, answer: BUSY });
      yield* workersOver(app, hosts, disk.dir);
      yield* Effect.sleep("50 millis");
      expect(hosts.list().map((each) => each.viaAccount)).toEqual([OWN, OTHER]);
      // A renewal names the second sign-in's organisation, and the app says its sign-ins changed.
      marks[1] = { origin: SECOND, account: ORG, formerAccounts: [OWN] };
      app.toServer({ type: "machines.signins" });
      // Moved at once, with no spawn from it and no pass: another sign-in's left as it is.
      yield* until(() => hosts.list()[0]?.viaAccount === ORG);
      expect(hosts.list().map((each) => each.viaAccount)).toEqual([ORG, OTHER]);
      expect(disk.owedAccounts()).toEqual([ORG, OTHER]);
    }).pipe(Effect.scoped),
  );

  it.live("has a move a restart cut short finished at the next start", () =>
    Effect.gen(function* () {
      // The machines were moved before the restart; the stops owed weren't yet.
      const disk = stopsOnDisk([{ origin: SECOND, name: GONE, since: 0, account: OWN }]);
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(disk.dir, { recursive: true })));
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionOn(hosts, NAME, ORG);
      const app = fakeApp({
        marks: () => [
          { origin: ORIGIN, account: ACCOUNT, formerAccounts: [] },
          { origin: SECOND, account: ORG, formerAccounts: [OWN] },
        ],
        answer: BUSY,
      });
      yield* workersOver(app, hosts, disk.dir);
      yield* until(() => disk.owedAccounts()[0] === ORG);
      expect(hosts.list().map((each) => each.viaAccount)).toEqual([ORG]);
    }).pipe(Effect.scoped),
  );
});

describe("a spawn under way as its sign-in takes its organisation's mark", () => {
  it.live("finds its machine under the new mark, and asks and owes under it from then on", () =>
    Effect.gen(function* () {
      const key = generateHostKey();
      const real = yield* RemoteHosts.make(memoryMachineStore());
      // The machine's host dials in only once the test says so.
      const online = { now: false };
      const hosts = {
        ...real,
        list: () => real.list().map((each) => (online.now ? { ...each, onlineSince: 1 } : each)),
      };
      const asked: Array<string | undefined> = [];
      const base = bridgeWorkerMachines(
        fakeApp({
          answer: () => ({ status: 200, body: { phase: "running", publicKey: key.publicKey } }),
        }).port,
      );
      const port: WorkerMachinePortShape = {
        ...base,
        call: (origin, call, body, options) => {
          asked.push(options?.account);
          return base.call(origin, call, body, options);
        },
      };
      // The layer's word of the sign-in's mark now (`markOf`), as its marks were last told.
      const promoted = { now: false };
      const source = signedInSource(
        { ...SERVER, account: OWN },
        {
          port,
          hosts,
          owed: memoryOwedStops(),
          everyMs: 5,
          timeoutMs: 2_000,
          markOf: (_origin, account) => (promoted.now && account === OWN ? ORG : undefined),
        },
      );
      const arriving = yield* Effect.forkScoped(source.arrive(NAME));
      // Registered under the mark the spawn began under.
      yield* until(() => real.list()[0]?.viaAccount === OWN);
      // A renewal names the organisation: the layer moves the machine, and tells its new mark.
      real.machines.remark(ORIGIN, OWN, ORG);
      promoted.now = true;
      asked.length = 0;
      yield* Effect.sleep("30 millis");
      online.now = true;
      // The spawn finds its own machine, moved, rather than failing it as another sign-in's.
      const arrived = yield* Fiber.join(arriving);
      expect(arrived).toBe(real.list()[0]?.id);
      expect(real.list().map((each) => each.viaAccount)).toEqual([ORG]);
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set([ORG]));
    }).pipe(Effect.scoped),
  );
});

describe("a move of a sign-in's stops whose write failed", () => {
  it("is written by the next move asked for, though nothing is left to move", () => {
    const disk = stopsOnDisk([{ origin: SECOND, name: NAME, since: 0, account: OWN }]);
    try {
      const owed = fileOwedStops(disk.dir);
      chmodSync(join(disk.dir, "remote-access"), 0o500);
      try {
        expect(owed.remark(SECOND, OWN, ORG)).toBe(false);
      } finally {
        chmodSync(join(disk.dir, "remote-access"), 0o700);
      }
      expect(disk.owedAccounts()).toEqual([OWN]);
      // The next pass asks again: written now, so a restart reads the new mark.
      expect(owed.remark(SECOND, OWN, ORG)).toBe(true);
      expect(disk.owedAccounts()).toEqual([ORG]);
    } finally {
      rmSync(disk.dir, { recursive: true, force: true });
    }
  });
});

describe("a stop owed under one sign-in", () => {
  it.live("isn't let go of when another sign-in registers a machine of its name", () =>
    Effect.gen(function* () {
      const key = generateHostKey();
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      // The first sign-in's start went unanswered: owed under it.
      const owed = memoryOwedStops();
      owed.add({ origin: ORIGIN, name: NAME, since: 0, unsettled: true, account: ACCOUNT });
      // A retry of the same request under another sign-in gets the same name, and its machine.
      const app = appSignedInAs(OTHER, (call) =>
        call === "status"
          ? { status: 200, body: { phase: "running", publicKey: key.publicKey } }
          : { status: 200, body: { stopped: true } },
      );
      const other = signedInSource(
        { ...SERVER, account: OTHER },
        { port: app.port, hosts, owed, everyMs: 5, timeoutMs: 500 },
      );
      yield* other.arrive(NAME);
      expect(hosts.list().map((each) => [each.name, each.viaAccount])).toEqual([[NAME, OTHER]]);
      // Its own give-back, confirmed, lets go of its own alone.
      yield* other.abandon(NAME);
      expect(owed.list().map((each) => each.account)).toEqual([ACCOUNT]);
    }),
  );

  it.effect("is neither sent nor let go of while another sign-in's machine has its name", () =>
    Effect.gen(function* () {
      const machines = [{ id: "m-1", name: NAME, via: ORIGIN, viaAccount: OTHER }];
      const claimed = claimedHere({ list: () => machines as never });
      const owed = memoryOwedStops();
      owed.add({ origin: ORIGIN, name: NAME, since: 0, account: ACCOUNT });
      owed.add({ origin: ORIGIN, name: NAME, since: 1, legacy: true });
      const app = appSignedInAs(ACCOUNT, () => ({ status: 200, body: { stopped: true } }));
      yield* settleOwedStops(app.port, owed, claimed);
      // Its stop might end the other sign-in's machine: kept, unsent. So is one whose is unknown.
      expect(app.sent).toEqual([]);
      expect(owed.list()).toHaveLength(2);
      // Its own sign-in's machine of the name: the release pass has it, and the owing goes.
      machines[0] = { ...machines[0]!, viaAccount: ACCOUNT };
      yield* settleOwedStops(app.port, owed, claimed);
      expect(owed.list().map((each) => each.legacy)).toEqual([true]);
    }),
  );
});
