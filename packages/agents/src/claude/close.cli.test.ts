import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type AgentEvent } from "@gram/contracts";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { beginChildShutdownCheck, notOrderlyExits } from "../child-process.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import { ClaudeEnvironment } from "./environment.ts";
import { ClaudeSdkLive } from "./sdk-live.ts";
import { ClaudeHost, ClaudeHostLayer } from "./session.ts";

// A real Claude Code CLI closed by the session, as the server's shutdown closes it, against an
// invented local provider: no account, no network. Opt in with the binary to run.
const cli = process.env["GRAM_CLAUDE_CLI"];

/**
 * A stand-in Anthropic API. A streamed request starts a reply that never ends, so the turn stays
 * under way, or is `rejected` with a 400; anything else gets a short answer.
 */
const provider = (reply: "endless" | "rejected") => {
  let turns = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const streamed =
        req.url?.startsWith("/v1/messages") === true && body.includes('"stream":true');
      if (!streamed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      turns += 1;
      if (reply === "rejected") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "fixture rejection" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: object) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      const timer = setInterval(
        () =>
          send("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "working " },
          }),
        200,
      );
      res.on("close", () => clearInterval(timer));
    });
  });
  return { server, turns: () => turns };
};

/**
 * Opens a session on the fixture provider and sends one message; `until` says when it is far enough
 * along to close. Closes it as the server's shutdown does, with the update's check on, and resolves
 * how long the close took.
 */
const closeAfterOneSend = (
  reply: "endless" | "rejected",
  until: (events: ReadonlyArray<AgentEvent>) => boolean,
) =>
  Effect.gen(function* () {
    const fixture = provider(reply);
    yield* Effect.promise(
      () => new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve)),
    );
    const address = fixture.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const home = mkdtempSync(join(tmpdir(), "gram-cli-close-"));
    const profileId = "fixture" as never;
    const layer = ClaudeHostLayer().pipe(
      Layer.provide(
        Layer.mergeAll(
          ClaudeSdkLive,
          Layer.succeed(ClaudeEnvironment)({
            invalidate: Effect.void,
            // Explicit, invented state: an empty home and config, telemetry and updates off.
            prepare: Effect.succeed({
              binaryPath: cli!,
              sdkExecutable: cli!,
              env: {
                PATH: "/usr/bin:/bin",
                HOME: home,
                CLAUDE_CONFIG_DIR: join(home, ".claude"),
                CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_AUTOUPDATER: "1",
                DISABLE_TELEMETRY: "1",
              },
              warnings: [],
            }),
            checkAuth: () => Effect.void,
          }),
          Layer.succeed(GatewayKeyProvider)({
            credentials: () =>
              Effect.succeed({
                profile: {
                  id: profileId,
                  name: "Fixture",
                  baseURL: `http://127.0.0.1:${port}/v1`,
                  keyRef: "profile:fixture",
                  models: [{ id: "fixture-model", name: "fixture-model" }],
                },
                key: Redacted.make("sk-fixture-not-a-key"),
              }),
          }),
        ),
      ),
    );
    const scope = yield* Scope.make();
    const events: Array<AgentEvent> = [];
    const session = yield* Effect.gen(function* () {
      const host = yield* ClaudeHost;
      return yield* host.open({
        threadId: ThreadId.make("cli-close"),
        cwd: home,
        model: { agent: "claude", model: "fixture-model", profileId },
      });
    }).pipe(Effect.provide(layer), Scope.provide(scope));
    yield* Effect.forkIn(
      Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))),
      scope,
    );
    yield* session.send({ text: "Keep working." });
    for (let i = 0; i < 300 && !until(events); i++) yield* Effect.sleep("100 millis");
    expect(fixture.turns()).toBeGreaterThan(0);

    const orderly = beginChildShutdownCheck();
    const startedAt = Date.now();
    yield* Scope.close(scope, Exit.void);
    const ms = Date.now() - startedAt;
    // The SDK's own SIGTERM, 2 s after `close`, must not be what ended it.
    yield* Effect.sleep("2500 millis");
    fixture.server.close();
    return { ms, orderly: orderly(), notOrderly: notOrderlyExits() };
  });

describe.skipIf(cli === undefined || process.platform === "win32")(
  "closing a real Claude Code session (GRAM_CLAUDE_CLI)",
  () => {
    it.live(
      "ends a turn under way so the CLI exits by itself, which the update's check takes as orderly",
      () =>
        Effect.gen(function* () {
          // Partway into the reply, as the update found two of its three sessions.
          const closed = yield* closeAfterOneSend("endless", (events) =>
            events.some((e) => e.type === "chunk" && e.chunk.type === "text-delta"),
          );
          console.log(JSON.stringify(closed));
          expect(closed.notOrderly).toEqual([]);
          expect(closed.orderly).toBe(true);
          expect(closed.ms).toBeLessThan(3_500);
        }),
      30_000,
    );

    it.live(
      "takes an idle CLI's exit 1 after a failed last turn as orderly",
      () =>
        Effect.gen(function* () {
          const closed = yield* closeAfterOneSend("rejected", (events) =>
            events.some((e) => e.type === "turnEnd"),
          );
          console.log(JSON.stringify(closed));
          expect(closed.notOrderly).toEqual([]);
          expect(closed.orderly).toBe(true);
          expect(closed.ms).toBeLessThan(3_500);
        }),
      30_000,
    );
  },
);
