// Shells on a server that holds threads readable by one person (`embedding/readable-by.ts`),
// behind a synthetic proxy: the server's own machine holds the database with every transcript, so
// once any thread is private nobody gets a shell there, and the shells already open close.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs, HostId, type TerminalId } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { removeDir } from "../git/test-repo.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { SHARED_MACHINE } from "../rpc/handlers/terminal.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { IDENTITY_HEADER } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { serverPort, ServerLayer } from "./server.ts";

const proxy = makeTestProxy();
const ada = { sub: "ada", name: "Ada", role: "member" };
const mo = { sub: "mo", name: "Mo", role: "member" };

const dirs: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "gram-readable-by-shells-"));
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

type Client = Effect.Success<ReturnType<typeof as>>;

const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(call), (exit) =>
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the call went through",
  );

/** Whether a connection is still listed `terminalId` as a running terminal. */
const running = (who: Client, terminalId: TerminalId) =>
  Effect.map(who["terminal.list"]({}), (all) =>
    all.some((terminal) => terminal.terminalId === terminalId && terminal.alive),
  );

describe("shells where a thread is readable by one person", () => {
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  layer(server, { excludeTestServices: true })("behind a fronting proxy", (it) => {
    it.effect("close on the server's machine once one is placed anywhere, and open no more", () =>
      Effect.gen(function* () {
        const port = serverPort(yield* HttpServer.HttpServer);
        const runtimes = yield* ThreadRuntimes;
        const adaClient = yield* as(port, ada);
        const moClient = yield* as(port, mo);

        // Before any thread is private, shells open here as ever.
        const mine = yield* moClient["terminal.open"]({ cols: 80, rows: 24 });
        const hers = yield* adaClient["terminal.open"]({ cols: 80, rows: 24 });
        expect(yield* running(moClient, mine.terminalId)).toBe(true);

        // Ada's thread goes on another machine; none of its checkouts is on this one.
        yield* runtimes.create({
          projectRoot: folder(),
          checkout: { kind: "main", path: folder(), hostId: HostId.make("m-elsewhere") },
          deferOpen: true,
          readableBy: "ada",
        });

        // The shells already open on this machine close, hers too: it holds the database.
        yield* waitReal(
          "the shells on this machine to close",
          Effect.map(
            Effect.all([running(moClient, mine.terminalId), running(adaClient, hers.terminalId)]),
            ([a, b]) => !a && !b,
          ),
        );

        // And no one opens another here, a sign-in shell of this machine's included.
        for (const who of [moClient, adaClient]) {
          expect(yield* outcome(who["terminal.open"]({ cols: 80, rows: 24 }))).toContain(
            SHARED_MACHINE,
          );
          expect(
            yield* outcome(
              who["terminal.open"]({ signIn: HostId.make("local"), cols: 80, rows: 24 }),
            ),
          ).toContain(SHARED_MACHINE);
        }
      }),
    );
  });
});
