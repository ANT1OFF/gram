import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Embedding } from "./embedding.ts";
import { EmbedInbound, type EmbedHandler } from "./inbound.ts";
import { Timers, TimersLive } from "./timers.ts";

/** What a scheduler was told, in order, and the token it was told with. */
interface Told {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

const TOKEN = "scheduler-token-0123456789abcdef0123";

/** A scheduler that records each call; `status` is what it answers. */
const scheduler = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; told: Array<Told>; url: string; answer: { status: number } }>(
        (resolve) => {
          const told: Array<Told> = [];
          const answer = { status: 200 };
          const server = createServer((req, res) => {
            let text = "";
            req.on("data", (chunk: Buffer) => (text += chunk.toString()));
            req.on("end", () => {
              told.push({
                method: req.method ?? "",
                path: req.url ?? "",
                auth: req.headers.authorization,
                body: text === "" ? undefined : JSON.parse(text),
              });
              res.writeHead(answer.status).end();
            });
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({
              server,
              told,
              answer,
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            }),
          );
        },
      ),
  ),
  ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
);

/** The routes the timers registered, to call as the inbound paths would. */
const routes = new Map<string, EmbedHandler>();
const FakeInbound = Layer.succeed(EmbedInbound, {
  route: (method, name, handler) =>
    Effect.sync(() => void routes.set(`${method} ${name}`, handler)),
  respond: () => Effect.succeed(undefined),
});

const withTimers = <A, E>(
  options: { readonly url?: string | undefined; readonly on?: boolean },
  use: (timers: (typeof Timers)["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.flatMap(Timers, use).pipe(
    Effect.provide(
      TimersLive.pipe(
        Layer.provide(FakeInbound),
        Layer.provide(
          Embedding.layerOf(
            options.url === undefined ? {} : { scheduler: { url: options.url, token: TOKEN } },
            Effect.succeed(options.on ?? true),
          ),
        ),
      ),
    ),
  );

// Loopback calls land in a few milliseconds; a loaded runner gets many times that.
const settle = Effect.sleep(Duration.millis(400));
const fire = (key: unknown) => routes.get("POST timers/fire")!({ key });

describe("Timers", () => {
  it.live("is a sleep with no scheduler, and with the hosted features off", () =>
    Effect.gen(function* () {
      const { told, url } = yield* scheduler;
      for (const options of [{}, { url, on: false }]) {
        yield* withTimers(options, (timers) =>
          Effect.gen(function* () {
            const started = Date.now();
            yield* timers.until("wake:a", started + 200);
            expect(Date.now() - started).toBeGreaterThanOrEqual(190);
          }),
        );
      }
      expect(told).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("registers a wait, and ends it when the scheduler calls", () =>
    Effect.gen(function* () {
      const { told, url } = yield* scheduler;
      yield* withTimers({ url }, (timers) =>
        Effect.gen(function* () {
          const at = Date.now() + 400;
          const wait = yield* Effect.forkScoped(timers.until("wake:b", at));
          yield* settle;
          expect(told).toEqual([
            {
              method: "PUT",
              path: "/v1/timers/wake%3Ab",
              auth: `Bearer ${TOKEN}`,
              body: { key: "wake:b", at: new Date(at).toISOString(), atMs: at },
            },
          ]);
          expect((yield* routes.get("GET timers")!(undefined)).body).toEqual({
            timers: [{ key: "wake:b", at: new Date(at).toISOString(), atMs: at }],
          });
          // A key nothing waits on, and one that is no key: the scheduler drops the first.
          expect((yield* fire("wake:gone")).body).toEqual({ fired: false });
          expect((yield* fire("../x")).status).toBe(400);

          expect((yield* fire("wake:b")).body).toEqual({ fired: true });
          yield* Fiber.join(wait);
          // Called a moment early by the scheduler's clock, it still ends at its time by this one.
          expect(Date.now()).toBeGreaterThanOrEqual(at);
          expect((yield* routes.get("GET timers")!(undefined)).body).toEqual({ timers: [] });
          yield* settle;
          // Fired from there: nothing to take back.
          expect(told.length).toBe(1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("takes a cancelled wait back, and a wait armed again ends registered", () =>
    Effect.gen(function* () {
      const { told, url } = yield* scheduler;
      yield* withTimers({ url }, (timers) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkScoped(timers.until("routine:w:r", Date.now() + 60_000));
          yield* settle;
          yield* Fiber.interrupt(first);
          yield* settle;
          expect(told.map((each) => each.method)).toEqual(["PUT", "DELETE"]);

          // Cancelled and armed again at once, as a rescheduled routine is.
          const later = Date.now() + 120_000;
          const second = yield* Effect.forkScoped(timers.until("routine:w:r", later));
          yield* Fiber.interrupt(second);
          const third = yield* Effect.forkScoped(timers.until("routine:w:r", later));
          yield* settle;
          expect(told.at(-1)).toMatchObject({ method: "PUT", body: { atMs: later } });
          yield* Fiber.interrupt(third);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "fires nothing it needn't wait for, and never loses a wait to a scheduler that is down",
    () =>
      Effect.gen(function* () {
        const { told, url, answer } = yield* scheduler;
        yield* withTimers({ url }, (timers) =>
          Effect.gen(function* () {
            yield* timers.until("wake:past", Date.now() - 1);
            expect(told).toEqual([]);
            // The scheduler refuses the registration: the wait goes on, and is still listed.
            answer.status = 503;
            const wait = yield* Effect.forkScoped(timers.until("wake:c", Date.now() + 60_000));
            yield* settle;
            expect(told.length).toBe(1);
            expect((yield* fire("wake:c")).body).toEqual({ fired: true });
            yield* Fiber.interrupt(wait);
          }),
        );
      }).pipe(Effect.scoped),
  );
});
