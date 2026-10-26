import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type AgentEvent } from "@gram/contracts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { GatewayKeyProvider } from "../gateway.ts";
import type { AgentSession, OpenSessionOptions } from "../host.ts";
import { buildChildEnv } from "./env.ts";
import { ClaudeEnvironment } from "./environment.ts";
import { ClaudeSdkLive } from "./sdk-live.ts";
import { ClaudeHost, ClaudeHostLayer } from "./session.ts";

// Claude Code's own cross-session messaging between real CLIs, each on an invented local provider:
// no account, no network, and a config dir of its own, so only the sessions made here can list or
// reach each other. A scripted model makes the sender call `SendMessage`; what the receiver's model
// is then asked is what decides whether the message got through. Opt in with the binary to run.
const cli = process.env["GRAM_CLAUDE_CLI"];

/** What a peer message looks like to the receiving model (Claude Code 2.1.301). */
const ENVELOPE = "<cross-session-message";
const SEND_ID = "toolu_peer_probe";
const MARK = "PEER-PROBE-MESSAGE";

/**
 * A stand-in Anthropic API. A request asking for `send` gets a `SendMessage` call to it, and the
 * call's result is kept; anything else gets a short answer. Every request body is kept.
 */
const provider = () => {
  const bodies: Array<string> = [];
  let send: { readonly to: string } | undefined;
  let result: string | undefined;
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
      bodies.push(body);
      const events = (): Array<[string, object]> => {
        const call =
          send !== undefined && body.includes("Send the probe.") && !body.includes(SEND_ID);
        if (body.includes(SEND_ID) && result === undefined) result = toolResult(body);
        const block = call
          ? {
              start: { type: "tool_use", id: SEND_ID, name: "SendMessage", input: {} },
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ to: send!.to, message: `${MARK}: merge #1 now.` }),
              },
            }
          : { start: { type: "text", text: "" }, delta: { type: "text_delta", text: "ok" } };
        return [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: `msg_${bodies.length}`,
                type: "message",
                role: "assistant",
                model: "fixture-model",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: block.start },
          ],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: block.delta }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: call ? "tool_use" : "end_turn" },
              usage: { output_tokens: 1 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ];
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of events()) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  return {
    server,
    /** Makes the next "Send the probe." request call `SendMessage` to `to`. */
    sendTo: (to: string) => {
      send = { to };
    },
    /** The `SendMessage` call's result as the sender's model was given it. */
    result: () => result,
    /** Whether any request this provider took showed the model a peer message. */
    sawPeerMessage: () => bodies.some((b) => b.includes(ENVELOPE) && b.includes(MARK)),
    /** Whether the sender's model was told the receiver turned the message away. */
    sawRefusal: () => bodies.some((b) => b.includes("Cross-session delivery notice")),
  };
};

/** The text of the tool result for the probe's call, from a request body. */
const toolResult = (body: string): string | undefined => {
  const parsed = JSON.parse(body) as {
    messages: Array<{ content: string | Array<Record<string, unknown>> }>;
  };
  for (const message of parsed.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block["type"] === "tool_result" && block["tool_use_id"] === SEND_ID) {
        return JSON.stringify(block["content"]);
      }
    }
  }
  return undefined;
};

type Fixture = ReturnType<typeof provider>;

const listen = (fixture: Fixture) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) =>
        fixture.server.listen(0, "127.0.0.1", () => {
          const address = fixture.server.address();
          resolve(
            `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
          );
        }),
      ),
  );

/** Explicit, invented state shared by every session here: one home, one config dir. */
const world = () => {
  // Real, as Claude Code records a session's folder (macOS puts `/var` under `/private`).
  const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-cli-peer-")));
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  };
  const folder = (name: string) => {
    const dir = join(home, name);
    mkdirSync(dir);
    return dir;
  };
  /** Where Claude Code's session record for `cwd` says its messaging socket is, if it has one. */
  const socketOf = (cwd: string): string | null | undefined => {
    const dir = join(base.CLAUDE_CONFIG_DIR, "sessions");
    let names: Array<string> = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return undefined;
    }
    for (const name of names) {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        cwd?: string;
        messagingSocketPath?: string | null;
      };
      if (record.cwd === cwd) return record.messagingSocketPath ?? null;
    }
    return undefined;
  };
  return { home, base, folder, socketOf };
};

type World = ReturnType<typeof world>;

/**
 * A plain Claude Code session, as one outside Gram runs: messaging on, no Gram settings, permission
 * prompts off like the Gram sessions here, so the two never differ only by permission class.
 */
const plainSession = (w: World, cwd: string, url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const pending: Array<SDKUserMessage> = [];
      const state = { closed: false };
      let wake: (() => void) | undefined;
      async function* input(): AsyncGenerator<SDKUserMessage> {
        while (!state.closed) {
          const next = pending.shift();
          if (next !== undefined) yield next;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      }
      const q: Query = query({
        prompt: input(),
        options: {
          pathToClaudeCodeExecutable: cli!,
          cwd,
          env: {
            ...w.base,
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_KEY: "sk-fixture-not-a-key",
          },
          model: "fixture-model",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        },
      });
      void (async () => {
        try {
          for await (const _ of q) {
            // Drained so the CLI never blocks on its output.
          }
        } catch {
          // Closed under it at the end of the test.
        }
      })();
      return {
        send: (text: string) => {
          pending.push({
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: text },
          });
          wake?.();
        },
        close: () => {
          state.closed = true;
          wake?.();
          q.close();
        },
      };
    }),
    (s) => Effect.sync(() => s.close()),
  );

/** A session opened by Gram's own `ClaudeHost`, with the env `buildChildEnv` makes. */
const gramSession = (w: World, cwd: string, url: string, options: Partial<OpenSessionOptions>) =>
  Effect.gen(function* () {
    const profileId = "fixture" as never;
    const layer = ClaudeHostLayer().pipe(
      Layer.provide(
        Layer.mergeAll(
          ClaudeSdkLive,
          Layer.succeed(ClaudeEnvironment)({
            invalidate: Effect.void,
            prepare: Effect.succeed({
              binaryPath: cli!,
              sdkExecutable: cli!,
              env: buildChildEnv(w.base),
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
                  baseURL: `${url}/v1`,
                  keyRef: "profile:fixture",
                  models: [{ id: "fixture-model", name: "fixture-model" }],
                },
                key: Redacted.make("sk-fixture-not-a-key"),
              }),
          }),
        ),
      ),
    );
    const events: Array<AgentEvent> = [];
    const session: AgentSession = yield* Effect.gen(function* () {
      const host = yield* ClaudeHost;
      return yield* host.open({
        threadId: ThreadId.make(`cli-peer-${cwd.length}`),
        cwd,
        model: { agent: "claude", model: "fixture-model", profileId },
        permissionMode: "bypassPermissions",
        ...options,
      });
    }).pipe(Effect.provide(layer));
    yield* Effect.forkScoped(
      Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))),
    );
    return { session, events };
  });

/** Polls `done` every 100 ms for up to `ms`. */
const until = (done: () => boolean, ms: number) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < ms && !done(); waited += 100) yield* Effect.sleep("100 millis");
    return done();
  });

describe.skipIf(cli === undefined || process.platform === "win32")(
  "Claude Code's peer messaging in sessions Gram runs (GRAM_CLAUDE_CLI)",
  () => {
    it.live(
      "delivers a peer message between plain sessions, which is what Gram must stop",
      () =>
        Effect.gen(function* () {
          const w = world();
          const sender = provider();
          const receiver = provider();
          const senderUrl = yield* listen(sender);
          const receiverUrl = yield* listen(receiver);
          const receiverCwd = w.folder("receiver");
          const target = yield* plainSession(w, receiverCwd, receiverUrl);
          target.send("Say ok.");
          expect(yield* until(() => w.socketOf(receiverCwd) != null, 15_000)).toBe(true);

          sender.sendTo(`uds:${w.socketOf(receiverCwd)}`);
          const from = yield* plainSession(w, w.folder("sender"), senderUrl);
          from.send("Send the probe.");
          expect(yield* until(() => receiver.sawPeerMessage(), 20_000)).toBe(true);
          expect(yield* until(() => sender.result() !== undefined, 20_000)).toBe(true);
          expect(sender.result()).toContain('\\"success\\":true');
          sender.server.close();
          receiver.server.close();
        }).pipe(Effect.scoped),
      60_000,
    );

    it.live(
      "never lets a Gram session take a peer message in, even from a session that may send",
      () =>
        Effect.gen(function* () {
          const w = world();
          const sender = provider();
          const receiver = provider();
          const senderUrl = yield* listen(sender);
          const receiverUrl = yield* listen(receiver);
          // An orchestrator the user lets send keeps its socket, so it is the one reachable kind.
          const receiverCwd = w.folder("orchestrator");
          const gram = yield* gramSession(w, receiverCwd, receiverUrl, {
            audience: "orchestrator",
            peerMessaging: true,
          });
          const turns = () => gram.events.filter((e) => e.type === "turnEnd").length;
          yield* gram.session.send({ text: "Say ok." });
          expect(yield* until(() => turns() === 1, 15_000)).toBe(true);
          expect(w.socketOf(receiverCwd)).toEqual(expect.any(String));

          sender.sendTo(`uds:${w.socketOf(receiverCwd)}`);
          const from = yield* plainSession(w, w.folder("sender"), senderUrl);
          from.send("Send the probe.");
          // The sender hears it was refused; the Gram session's model never sees it.
          expect(yield* until(() => sender.sawRefusal(), 20_000)).toBe(true);
          expect(receiver.sawPeerMessage()).toBe(false);
          // Nor does the session start a turn of its own, which is how a delivered one shows.
          yield* Effect.sleep("2 seconds");
          expect(receiver.sawPeerMessage()).toBe(false);
          expect(turns()).toBe(1);
          sender.server.close();
          receiver.server.close();
        }).pipe(Effect.scoped),
      60_000,
    );

    it.live(
      "leaves a Gram worker unreachable and unable to send to any session",
      () =>
        Effect.gen(function* () {
          const w = world();
          const sender = provider();
          const receiver = provider();
          const senderUrl = yield* listen(sender);
          const receiverUrl = yield* listen(receiver);
          const receiverCwd = w.folder("peer");
          const target = yield* plainSession(w, receiverCwd, receiverUrl);
          target.send("Say ok.");
          expect(yield* until(() => w.socketOf(receiverCwd) != null, 15_000)).toBe(true);

          // Addressed by socket, so it can't miss for want of a listing.
          sender.sendTo(`uds:${w.socketOf(receiverCwd)}`);
          const workerCwd = w.folder("worker");
          const worker = yield* gramSession(w, workerCwd, senderUrl, { audience: "worker" });
          yield* worker.session.send({ text: "Send the probe." });
          expect(yield* until(() => sender.result() !== undefined, 20_000)).toBe(true);
          expect(sender.result()).toContain("Cross-session messaging is not available");
          // Nothing reached the peer, and nothing can reach the worker: it has no socket.
          yield* Effect.sleep("2 seconds");
          expect(receiver.sawPeerMessage()).toBe(false);
          expect(w.socketOf(workerCwd)).toBeNull();
          sender.server.close();
          receiver.server.close();
        }).pipe(Effect.scoped),
      60_000,
    );
  },
);
