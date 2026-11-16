// The acceptance test for a server with no local user: a headless one, or one people sign in to
// through a fronting proxy. A whole server over a real socket, whose opener records what it would
// start: a signed-in member's `editor.open`, `fs.reveal`, `app.openExternal` and
// `app.openLogsFolder` are refused and nothing is started, and the settings that pick a program or
// a folder on the server can't be changed. The desktop app on its own still opens what it asks.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, GramRpcs } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { removeDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { type LaunchSpec, NO_LOCAL_PROGRAMS, Opener } from "../platform/opener.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { hostProgramRefusal } from "../rpc/handlers/settings.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { tokenCookieName } from "./auth.ts";
import { IDENTITY_HEADER } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { LaunchToken, serverPort, ServerLayer } from "./server.ts";

const proxy = makeTestProxy();
const ada = { sub: "user-ada", name: "Ada", role: "member" };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});
const tempDir = (prefix: string) => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(made);
  return made;
};

/** The whole server, with an opener that records each program it is asked to start. */
const server = (
  launched: Array<LaunchSpec>,
  options: { readonly fronted: boolean; readonly headless: boolean },
) =>
  ServerLayer.pipe(
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir: tempDir("gram-no-programs-data-"),
        ...(options.fronted ? { frontedIdentity: proxy.config, embedding: true } : {}),
        ...(options.headless ? { headless: true, embedding: true } : {}),
      }),
    ),
    Layer.provide(
      Layer.succeed(Opener, {
        launch: (spec) => Effect.sync(() => void launched.push(spec)),
      }),
    ),
    Layer.orDie,
  );

const portOf = Effect.gen(function* () {
  return { port: serverPort(yield* HttpServer.HttpServer), token: (yield* LaunchToken).token };
});

/** An RPC client whose connection carries `headers`, living in the caller's scope. */
const client = (port: number, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as never)),
        Layer.provide(NodeWS.layerWebSocketConstructor),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
  });

/** The launch cookie the app's window gets from its boot link. */
const bootCookie = (port: number, token: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve(res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );

/** Why a call was refused, as the server said it; a call that went through says so. */
const refusal = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(call), (exit) =>
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the call went through",
  );

/** Every call that would start a program here, for a file and a folder that exist. */
const startsAProgram = (
  rpc: Effect.Success<ReturnType<typeof client>>,
  file: string,
  folder: string,
) => [
  rpc["editor.open"]({ path: file, line: 1 }),
  rpc["editor.open"]({ path: folder }),
  rpc["fs.reveal"]({ path: file }),
  rpc["app.openExternal"]({ url: "https://example.invalid/" }),
  rpc["app.openLogsFolder"](),
];

describe("a server with no local user", () => {
  for (const headless of [true, false])
    it.live(
      `${headless ? "headless, " : ""}with sign-in through a proxy: a member starts no program, and can't pick one`,
      () =>
        Effect.gen(function* () {
          const launched: Array<LaunchSpec> = [];
          const ctx = yield* Layer.build(server(launched, { fronted: true, headless }));
          const { port } = yield* portOf.pipe(Effect.provideContext(ctx));
          const store = yield* ThreadStore.pipe(Effect.provideContext(ctx));
          const folder = tempDir("gram-no-programs-files-");
          const file = join(folder, "notes.txt");
          writeFileSync(file, "notes\n");
          const member = yield* client(port, { [IDENTITY_HEADER]: proxy.statement(ada) });

          // The member tries to pick the program first: refused whole, the stored value unchanged.
          const before = (yield* store.getSettings).editor.command;
          expect(
            yield* refusal(
              member["settings.set"]({
                patch: { editor: { command: `${process.execPath} -e "" {path}` } },
              }),
            ),
          ).toContain(hostProgramRefusal(["editor", "command"]));
          expect(
            yield* refusal(member["settings.set"]({ patch: { terminal: { shell: "/bin/sh" } } })),
          ).toContain(hostProgramRefusal(["terminal", "shell"]));
          expect((yield* store.getSettings).editor.command).toBe(before);

          // Even with a command stored (as if set before), opening anything is refused, and nothing
          // is started.
          yield* store.updateSettings(
            (settings) =>
              applySettingsPatch(settings, { editor: { command: `${process.execPath} {path}` } }),
            [["editor", "command"]],
          );
          for (const call of startsAProgram(member, file, folder))
            expect(yield* refusal(call)).toContain(NO_LOCAL_PROGRAMS);
          // Refused before the path is looked at: one that doesn't exist gets the same answer.
          expect(
            yield* refusal(member["editor.open"]({ path: join(folder, "missing.txt") })),
          ).toContain(NO_LOCAL_PROGRAMS);
          expect(launched).toEqual([]);
        }).pipe(Effect.scoped),
    );

  it.live("headless, the app's own window starts no program either", () =>
    Effect.gen(function* () {
      const launched: Array<LaunchSpec> = [];
      const ctx = yield* Layer.build(server(launched, { fronted: false, headless: true }));
      const { port, token } = yield* portOf.pipe(Effect.provideContext(ctx));
      const cookie = yield* bootCookie(port, token);
      expect(cookie.startsWith(`${tokenCookieName(port)}=`)).toBe(true);
      const app = yield* client(port, { cookie });
      const folder = tempDir("gram-no-programs-files-");
      const file = join(folder, "notes.txt");
      writeFileSync(file, "notes\n");

      for (const call of startsAProgram(app, file, folder))
        expect(yield* refusal(call)).toContain(NO_LOCAL_PROGRAMS);
      expect(launched).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("on the desktop, with nobody signed in through a proxy, opens what the window asks", () =>
    Effect.gen(function* () {
      const launched: Array<LaunchSpec> = [];
      const ctx = yield* Layer.build(server(launched, { fronted: false, headless: false }));
      const { port, token } = yield* portOf.pipe(Effect.provideContext(ctx));
      const app = yield* client(port, { cookie: yield* bootCookie(port, token) });
      const folder = tempDir("gram-no-programs-files-");
      const file = join(folder, "notes.txt");
      writeFileSync(file, "notes\n");

      yield* app["settings.set"]({ patch: { editor: { command: "zed" } } });
      yield* app["editor.open"]({ path: file, line: 3 });
      yield* app["fs.reveal"]({ path: file });
      yield* app["app.openExternal"]({ url: "https://example.invalid/" });
      yield* app["app.openLogsFolder"]();
      expect(launched).toHaveLength(4);
      expect(launched[0]?.args.join(" ")).toContain(file);
    }).pipe(Effect.scoped),
  );
});
