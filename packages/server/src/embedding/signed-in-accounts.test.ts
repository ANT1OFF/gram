// One sign-in's worker machines and the stops owed for them, kept apart from another sign-in's at
// the same hosted server: every call carries the sign-in's mark, and nothing made under one is
// settled or let go of by another. A fake app over the port, no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { generateHostKey } from "../host/machine-keys.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ACCOUNT, fakeApp, NAME, ORIGIN, SERVER } from "./signed-in-fixtures.ts";
import {
  bridgeWorkerMachines,
  claimedHere,
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
