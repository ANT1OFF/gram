// Whom a thread works for (`Thread.startedBy`) and the names behind it (`people.names`): a whole
// server behind a synthetic proxy. A thread is the signed-in person's who started it; what it
// spawns works for them too, whoever's call that was; no write changes it; and a person's name is
// the one they last signed in under.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { ActingPerson } from "../embedding/person.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { removeDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { IDENTITY_HEADER } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { serverPort, ServerLayer } from "./server.ts";

const proxy = makeTestProxy();

const dirs: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "gram-started-by-"));
  dirs.push(made);
  return made;
};

const server = ServerLayer.pipe(
  Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(
    ServerConfig.layer({
      ...TEST_CONFIG,
      dataDir: folder(),
      frontedIdentity: proxy.config,
      embedding: true,
    }),
  ),
  Layer.orDie,
);

/** An RPC client signed in as `claims`, living in the caller's scope. */
const as = (port: number, claims: Record<string, unknown>) =>
  Effect.gen(function* () {
    const headers = { [IDENTITY_HEADER]: proxy.statement(claims) };
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) =>
              new (globalThis.WebSocket as unknown as new (
                url: string,
                init: { headers: Record<string, string> },
              ) => globalThis.WebSocket)(url, { headers }),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
  });

/** What a person's recorded call leaves behind, under the name they signed in with. */
const entry = (name: string, at: number) => ({
  at,
  actor: { id: "ada", name, role: "member" },
  action: "settings.set",
  data: {},
});

describe("whom a thread works for", () => {
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  layer(server, { excludeTestServices: true })("with fronted sign-in", (it) => {
    it.effect("is who started it, for good, and its spawner's for what it spawns", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const made = (input: Partial<Parameters<typeof runtimes.create>[0]>) =>
          runtimes.create({
            projectRoot: folder(),
            checkout: { kind: "main", path: folder() },
            deferOpen: true,
            ...input,
          });
        const adas = yield* made({}).pipe(Effect.provideService(ActingPerson, "ada"));
        expect(adas.startedBy).toBe("ada");
        // Mo's call makes the worker, but it works for Ada, as its spawner does.
        const worker = yield* made({ spawnedBy: { threadId: adas.id, feature: "f" } }).pipe(
          Effect.provideService(ActingPerson, "mo"),
        );
        expect(worker.startedBy).toBe("ada");
        // No write clears it or hands it to someone else.
        yield* store.updateThread(worker.id, (thread) => {
          const { startedBy: _, ...rest } = thread;
          return rest;
        });
        yield* store.updateThread(worker.id, (thread) => ({ ...thread, startedBy: "mo" }));
        expect((yield* store.getThread(worker.id)).startedBy).toBe("ada");
        // Nobody's thread stays nobody's.
        const nobodys = yield* made({});
        expect(nobodys.startedBy).toBeUndefined();
        yield* store.updateThread(nobodys.id, (thread) => ({ ...thread, startedBy: "mo" }));
        expect((yield* store.getThread(nobodys.id)).startedBy).toBeUndefined();
      }),
    );

    it.effect("is named by the name they last signed in under, to anyone signed in", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.appendActorEvents([entry("Ada L.", 1), entry("Ada Lovelace", 2)]);
        const port = serverPort(yield* HttpServer.HttpServer);
        const mo = yield* as(port, { sub: "mo", name: "Mo", role: "member" });
        expect(yield* mo["people.names"]({ ids: ["ada", "someone-unknown"] })).toEqual({
          you: "mo",
          people: [{ id: "ada", name: "Ada Lovelace" }],
        });
      }),
    );
  });
});
