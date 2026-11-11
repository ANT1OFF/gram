// The embedding seams end to end, over a real socket: a server built as `main.ts` builds it (the
// fake agent, real git over a temp repository, a database in memory), called the way an embedding
// platform's services call it.

import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs, type PrStatus, type ServerEvent } from "@gram/contracts";
import { Pr } from "@gram/git";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { EventHub } from "../events/event-hub.ts";
import { eventually, makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { LaunchToken, ServerLayer, serverPort } from "../http/server.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";

const TOKEN = "embed-acceptance-token-0123456789abcdef";

const tmp = tempDir();
afterAll(() => removeDir(tmp));

interface Answer {
  readonly status: number;
  readonly body: string;
  /** The first cookie the answer set, if any. */
  readonly cookie: string;
}

const call = (
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string | undefined;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
    /** The `Host` a service inside the deployment sends: never loopback's. */
    readonly host?: string;
  } = {},
) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: options.method ?? "POST",
            agent: false,
            headers: {
              host: options.host ?? "gram.workspace.svc.cluster.local:8080",
              ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...options.headers,
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                cookie: res.headers["set-cookie"]?.[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
      }),
  );

const port = Effect.map(HttpServer.HttpServer, serverPort);

/** The app's own connection: the launch cookie from loopback, over `/ws`. */
const appClient = Effect.gen(function* () {
  const at = yield* port;
  const { token } = yield* LaunchToken;
  const boot = yield* call(at, `/?boot=${token}`, { method: "GET", host: `127.0.0.1:${at}` });
  expect(boot.status).toBe(302);
  const cookie = boot.cookie.split(";")[0] ?? "";
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${at}/ws`)),
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (url) =>
            new (globalThis.WebSocket as unknown as new (
              url: string,
              init: { headers: Record<string, string> },
            ) => globalThis.WebSocket)(url, { headers: { cookie } }),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
});

const SCHEDULER_TOKEN = "scheduler-acceptance-token-0123456789";

/**
 * The deployment's scheduler: it keeps each timer it is told of, and calls the server back when
 * `ring` says a timer's time has come.
 */
const scheduler = {
  timers: new Map<string, number>(),
  calls: [] as Array<{ readonly method: string; readonly path: string; readonly auth?: string }>,
};
const schedulerServer = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk: Buffer) => (text += chunk.toString()));
  req.on("end", () => {
    const key = decodeURIComponent((req.url ?? "").replace("/v1/timers/", ""));
    scheduler.calls.push({
      method: req.method ?? "",
      path: req.url ?? "",
      ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
    });
    if (req.method === "PUT")
      scheduler.timers.set(key, (JSON.parse(text) as { atMs: number }).atMs);
    if (req.method === "DELETE") scheduler.timers.delete(key);
    res.writeHead(200).end();
  });
});
await new Promise<void>((resolve) => schedulerServer.listen(0, "127.0.0.1", resolve));
afterAll(() => void schedulerServer.close());
const schedulerUrl = `http://127.0.0.1:${(schedulerServer.address() as AddressInfo).port}/v1`;

const badge = (checks: PrStatus["checks"]): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/7",
  title: "Add the thing",
  isDraft: false,
  checks,
  headMatches: true,
  aheadOfPr: false,
});

/** What GitHub would say of the repository's PR, and how often it was asked. */
const github = { checks: "pending" as PrStatus["checks"], asked: 0 };

const MockPr = Layer.succeed(Pr, {
  status: () =>
    Effect.sync(() => {
      github.asked++;
      return badge(github.checks);
    }),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

const server = (config: Partial<Parameters<typeof ServerConfig.layer>[0]>) =>
  ServerLayer.pipe(
    Layer.provide(FakeAgentAdapter),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest({ pr: MockPr })),
    Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, ...config })),
    Layer.orDie,
    Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
  );

const embed = {
  repoEvents: "pushed" as const,
  inboundToken: TOKEN,
  scheduler: { url: schedulerUrl, token: SCHEDULER_TOKEN },
};

const repoEvent = { events: [{ repo: "acme/web", number: 7, kind: "check" }] };

layer(server({ embedding: true, embed }), { excludeTestServices: true })(
  "an embedded server",
  (it) => {
    describe("its inbound paths", () => {
      it.effect("take a service's bearer token, whatever Host it was reached by", () =>
        Effect.gen(function* () {
          const at = yield* port;
          const none = yield* call(at, "/embed/v1/repo-events", { body: repoEvent });
          expect(none.status).toBe(401);
          const wrong = yield* call(at, "/embed/v1/repo-events", {
            token: "x".repeat(TOKEN.length),
            body: repoEvent,
          });
          expect(wrong.status).toBe(401);
          const ok = yield* call(at, "/embed/v1/repo-events", { token: TOKEN, body: repoEvent });
          expect(ok.status).toBe(200);
          expect(JSON.parse(ok.body)).toMatchObject({ accepted: 1 });
        }),
      );

      it.effect("refuse a browser, a path they don't have and a body that isn't one", () =>
        Effect.gen(function* () {
          const at = yield* port;
          const browser = yield* call(at, "/embed/v1/repo-events", {
            token: TOKEN,
            body: repoEvent,
            headers: { origin: "https://attacker.example" },
          });
          expect(browser.status).toBe(403);
          expect((yield* call(at, "/embed/v1/nothing", { token: TOKEN })).status).toBe(404);
          expect(
            (yield* call(at, "/embed/v1/repo-events", { token: TOKEN, method: "GET" })).status,
          ).toBe(405);
          for (const body of [{}, { events: [] }, { events: [{ repo: "no-slash" }] }]) {
            const refused = yield* call(at, "/embed/v1/repo-events", { token: TOKEN, body });
            expect(refused.status).toBe(400);
          }
          // The token opens these paths and nothing else.
          expect((yield* call(at, "/ws", { token: TOKEN, method: "GET" })).status).toBe(403);
          expect((yield* call(at, "/", { token: TOKEN, method: "GET" })).status).toBe(403);
        }),
      );
    });

    it.effect("reads a pull request when its event is pushed, not before", () =>
      Effect.gen(function* () {
        const at = yield* port;
        const runtimes = yield* ThreadRuntimes;
        const hub = yield* EventHub;
        // The checks each `git.state` the server sent its clients showed, in order.
        const shown: Array<string | undefined> = [];
        yield* hub
          .internalEvents(
            (event): event is Extract<ServerEvent, { type: "git.state" }> =>
              event.type === "git.state",
            "acceptance",
          )
          .pipe(
            Stream.runForEach((event) => Effect.sync(() => shown.push(event.state.pr?.checks))),
            Effect.forkScoped({ startImmediately: true }),
          );
        const repo = makeRepo(tmp);
        const created = yield* runtimes.create({
          projectRoot: repo,
          checkout: { kind: "main", path: repo },
        });
        // A worker's thread, bound to the pull request it opened.
        yield* runtimes.updateThread(created.id, (thread) => ({
          ...thread,
          boundPr: { repo: "acme/web", number: 7, monitor: false },
        }));

        // Its checks are running on GitHub. Nothing here asks, so nothing here knows.
        yield* Effect.sleep("500 millis");
        expect(github.asked).toBe(0);
        expect(shown.filter((checks) => checks !== undefined)).toEqual([]);

        // Another repository's event reads nothing; this one's reads the checkout.
        const other = yield* call(at, "/embed/v1/repo-events", {
          token: TOKEN,
          body: { events: [{ repo: "acme/api", number: 7 }] },
        });
        expect(JSON.parse(other.body)).toEqual({ accepted: 1, checkouts: 0 });
        const opened = yield* call(at, "/embed/v1/repo-events", { token: TOKEN, body: repoEvent });
        expect(JSON.parse(opened.body)).toEqual({ accepted: 1, checkouts: 1 });
        yield* eventually(
          "the pull request shown",
          Effect.sync(() => shown.at(-1) === "pending"),
        );

        // The checks pass, and the event saying so is all that tells the server.
        github.checks = "passing";
        const asked = github.asked;
        yield* Effect.sleep("300 millis");
        expect(github.asked).toBe(asked);
        yield* call(at, "/embed/v1/repo-events", { token: TOKEN, body: repoEvent });
        yield* eventually(
          "the passing checks shown",
          Effect.sync(() => shown.at(-1) === "passing"),
        );
        expect(github.asked).toBeGreaterThan(asked);
      }).pipe(Effect.scoped),
    );

    it.effect("registers a snooze with the scheduler, which brings the thread back", () =>
      Effect.gen(function* () {
        const at = yield* port;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const app = yield* appClient;
        const thread = yield* runtimes.create({
          projectRoot: tmp,
          checkout: { kind: "main", path: tmp },
        });
        const key = `snooze:${thread.id}`;

        // The user snoozes it for a few seconds: the server keeps the snooze, and tells the
        // scheduler only its key and its time.
        const until = Date.now() + 2_500;
        yield* app["thread.snooze"]({ threadId: thread.id, until });
        yield* eventually(
          "the timer registered",
          Effect.sync(() => scheduler.timers.get(key) === until),
        );
        expect(scheduler.calls.every((each) => each.auth === `Bearer ${SCHEDULER_TOKEN}`)).toBe(
          true,
        );
        const listed = yield* call(at, "/embed/v1/timers", { token: TOKEN, method: "GET" });
        expect(JSON.parse(listed.body)).toMatchObject({ timers: [{ key, atMs: until }] });

        // Its time comes, by the scheduler's clock, and the scheduler calls.
        yield* Effect.sleep(`${Math.max(0, until - Date.now())} millis`);
        const fired = yield* call(at, "/embed/v1/timers/fire", { token: TOKEN, body: { key } });
        expect(JSON.parse(fired.body)).toEqual({ fired: true });
        // Back and unread within moments: the wait's own fallback is half a minute away.
        const back = yield* eventually(
          "the thread back",
          Effect.map(store.getThread(thread.id), (found) =>
            found.snoozedUntil === undefined ? found : undefined,
          ),
          5_000,
        );
        expect(back.unread).toBe(true);
        // A second call for it finds nothing waiting, so the scheduler drops it.
        const again = yield* call(at, "/embed/v1/timers/fire", { token: TOKEN, body: { key } });
        expect(JSON.parse(again.body)).toEqual({ fired: false });

        // A snooze the user takes back is taken back from the scheduler too.
        yield* app["thread.snooze"]({ threadId: thread.id, until: Date.now() + 3_600_000 });
        yield* eventually(
          "the second timer registered",
          Effect.sync(() => scheduler.timers.has(key)),
        );
        yield* app["thread.snooze"]({ threadId: thread.id, until: null });
        yield* eventually(
          "the timer withdrawn",
          Effect.sync(() => !scheduler.timers.has(key)),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("holds the settings it is supplied against a change from inside", () =>
      Effect.gen(function* () {
        const at = yield* port;
        const app = yield* appClient;
        expect((yield* app["settings.get"]()).logLevel).toBe("info");

        const put = yield* call(at, "/embed/v1/settings", {
          token: TOKEN,
          method: "PUT",
          body: { settings: { logLevel: "debug", notifications: { sounds: false } } },
        });
        expect(JSON.parse(put.body)).toEqual({ supplied: ["logLevel", "notifications.sounds"] });
        const now = yield* app["settings.get"]();
        expect(now.logLevel).toBe("debug");
        expect(now.notifications.sounds).toBe(false);

        // The user's own window can't change either, and is told whose they are.
        const refused = yield* Effect.flip(app["settings.set"]({ patch: { logLevel: "warn" } }));
        expect(refused).toMatchObject({
          _tag: "InvalidState",
          message: expect.stringContaining("logLevel is set by the service that runs this Gram"),
        });
        // What isn't supplied still changes, beside a supplied value repeated as it stands.
        const changed = yield* app["settings.set"]({
          patch: { notifications: { sounds: false, native: false } },
        });
        expect(changed.notifications).toMatchObject({ sounds: false, native: false });
        expect(changed.logLevel).toBe("debug");

        // The switch for all of this is never supplied.
        const flag = yield* call(at, "/embed/v1/settings", {
          token: TOKEN,
          method: "PUT",
          body: { settings: { experimental: { embedding: false } } },
        });
        expect(flag.status).toBe(400);

        // Supplying nothing gives the settings back to the user, at the values they last had.
        const cleared = yield* call(at, "/embed/v1/settings", {
          token: TOKEN,
          method: "PUT",
          body: { settings: {} },
        });
        expect(cleared.status).toBe(200);
        const read = yield* call(at, "/embed/v1/settings", { token: TOKEN, method: "GET" });
        expect(JSON.parse(read.body)).toEqual({ settings: null });
        expect((yield* app["settings.set"]({ patch: { logLevel: "info" } })).logLevel).toBe("info");
      }).pipe(Effect.scoped),
    );
  },
);

layer(server({ embed }), { excludeTestServices: true })(
  "a server with the hosted features off",
  (it) => {
    it.effect("has no inbound paths, whatever its environment configured", () =>
      Effect.gen(function* () {
        const at = yield* port;
        const embedded = yield* call(at, "/embed/v1/repo-events", {
          token: TOKEN,
          body: repoEvent,
        });
        const unknown = yield* call(at, "/no/such/path", { token: TOKEN, body: repoEvent });
        expect(embedded).toEqual(unknown);
        expect(embedded.status).toBe(403);
        // From loopback too it is any other path: the launch cookie's, which no service has.
        const local = yield* call(at, "/embed/v1/repo-events", {
          token: TOKEN,
          body: repoEvent,
          host: `127.0.0.1:${at}`,
        });
        expect(local.status).toBe(401);
      }),
    );
  },
);
