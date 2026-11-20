// `spawn_worker`'s `sandbox` in the desktop app, where the machine comes from a hosted server the
// app is signed in to (`embedding/signed-in-workers.ts`). A fake app answers for that server: no
// network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NO_SIGNED_IN_SERVER,
  SignedInWorkers,
  signedInSource,
  type WorkerMachinePortShape,
} from "../embedding/signed-in-workers.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeWorld, openOrchestrator, serverLayer } from "./test-harness.ts";

const SERVER = { origin: "https://hosted.example.test", server: "Example hosted" };

const SANDBOX = {
  project: "shop",
  feature: "heavy-build",
  title: "Heavy build",
  brief: "Synthetic work",
  clientRequestId: "heavy-1",
  sandbox: { own: true, size: "large", reason: "A long build." },
};

/** A port to an app whose server answers each call with `answer`, recording what it was asked. */
const fakePort = (
  answer: (call: string) => { readonly status: number; readonly body: unknown },
) => {
  const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
  const port: WorkerMachinePortShape = {
    available: true,
    server: () => Effect.succeed({ ok: true as const, server: SERVER }),
    call: (_origin, call, body) =>
      Effect.sync(() => {
        calls.push({ call, body });
        return { ok: true as const, ...answer(call) };
      }),
    relay: () => undefined,
    unrelay: () => undefined,
    onDial: () => undefined,
  };
  return { port, calls };
};

const signedIn = (service: SignedInWorkers["Service"]) => Layer.succeed(SignedInWorkers)(service);

describe("sandbox from a signed-in hosted server", () => {
  it.effect(
    "is refused, naming the sign-in, while no server the app is signed in to offers it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { port } = fakePort(() => ({ status: 200, body: {} }));
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(
              signedIn({ port, source: Effect.succeed({ refused: NO_SIGNED_IN_SERVER }) }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { session } = yield* openOrchestrator(world);
          const before = yield* store.listThreads;
          const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              message: expect.stringMatching(
                /^Workers can't have machines of their own here: Sign in to a hosted server that offers worker machines \(Settings → Machines → Hosted servers\).*Leave out sandbox/,
              ),
            },
          });
          expect(yield* store.listThreads).toEqual(before);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );

  it.live("stops the machine it asked for when it never joins, and starts no worker", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // The server starts it, and it never gets as far as making its key.
      const { port, calls } = fakePort((call) =>
        call === "choices"
          ? { status: 404, body: {} }
          : call === "status"
            ? { status: 200, body: { phase: "booting" } }
            : { status: 202, body: {} },
      );
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 100, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session } = yield* openOrchestrator(world);
        const before = yield* store.listThreads;
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              /^The machine worker-[a-z0-9]+ didn't join within \d+ minutes, so it was stopped/,
            ),
          },
        });
        const asked = calls.map((each) => each.call);
        expect(asked[0]).toBe("choices");
        expect(asked).toContain("start");
        expect(asked.at(-1)).toBe("stop");
        const started = calls.find((each) => each.call === "start")!.body as { name: string };
        expect(calls.at(-1)!.body).toEqual({ name: started.name });
        expect(yield* store.listThreads).toEqual(before);
        expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a model the server's machines don't run, before any machine is asked for",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { port, calls } = fakePort((call) =>
          call === "choices"
            ? {
                status: 200,
                body: {
                  choices: [],
                  models: [{ agent: "claude", id: "hosted-only", label: "Hosted" }],
                },
              }
            : { status: 202, body: {} },
        );
        const hosts = {
          list: () => [],
          remove: () => false,
          machines: {
            provision: () => {
              throw new Error("not registered here");
            },
          },
        };
        const source = signedInSource(SERVER, { port, hosts });
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
          ),
        );
        yield* Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              message: expect.stringMatching(
                /^Example hosted's worker machines don't run \S+, so no machine was asked for\. They run claude:hosted-only \(Hosted\)/,
              ),
            },
          });
          expect(calls.map((each) => each.call)).toEqual(["choices"]);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );

  it.live("gives back a machine that came when the spawn is then refused", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      let started = false;
      const { port, calls } = fakePort((call) => {
        if (call === "start") started = true;
        return call === "choices" ? { status: 404, body: {} } : { status: 202, body: {} };
      });
      // It comes online as soon as it is asked for; this Gram's own machines don't know it, so
      // the placement after it is refused.
      const machine = {
        id: "m-0123456789abcdef01234567",
        name: "",
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
      };
      const hosts = {
        list: () => (started ? [machine] : []),
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 1_000, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({
              port,
              source: Effect.succeed({
                source: {
                  ...source,
                  start: (ask) => {
                    machine.name = ask.name;
                    return source.start(ask);
                  },
                },
                server: SERVER,
              }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(calls.map((each) => each.call)).toEqual(["choices", "start", "stop"]);
        expect(calls.at(-1)!.body).toEqual({ name: machine.name });
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );
});
