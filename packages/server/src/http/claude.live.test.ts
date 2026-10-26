import { describe, expect, it } from "@effect/vitest";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import {
  GramRpcs,
  type MessageId,
  type RequestId,
  type ServerEvent,
  type GramUIMessage,
  type ThreadFeedEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { ServerConfig } from "../config.ts";
import { GitPlatformLive } from "../git/platform.ts";
import { GitTurnHooksLive } from "../git/turn-hooks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { LaunchToken, serverPort, ServerLayer } from "./server.ts";

// Runs the real `claude` (Haiku, Sonnet for effort) end to end; opt in with GRAM_LIVE_CLAUDE=1.
const LIVE = process.env["GRAM_LIVE_CLAUDE"] === "1";

// Sessions, settings and project state go to a temp config dir, never the real ~/.claude. The
// subscription login lives in the keychain, so it still applies.
let previousConfigDir: string | undefined;
let configDir: string | undefined;
beforeAll(() => {
  if (!LIVE) return;
  previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  configDir = mkdtempSync(join(tmpdir(), "gram-live-claude-config-"));
  process.env["CLAUDE_CONFIG_DIR"] = configDir;
});
afterAll(async () => {
  if (configDir === undefined) return;
  if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
  // The CLI can still be writing session state as the last query closes.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const ClaudeAgents = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    return AgentHosts.fromHosts([yield* ClaudeHost]);
  }),
).pipe(Layer.provide(ClaudeHostLive()));

const LiveServer = ServerLayer.pipe(
  Layer.provide(ClaudeAgents),
  Layer.provide(GitTurnHooksLive),
  Layer.provide(GitPlatformLive),
  Layer.provide(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

const HAIKU = { agent: "claude", model: "haiku" } as const;

/** Haiku takes no effort; Sonnet does, and Claude Code exposes the active level to Bash. */
const sonnetAt = (variant: "low" | "high") =>
  ({ agent: "claude", model: "sonnet", variant }) as const;

const bootCookie = (port: number, token: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve((res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );

const until = <A>(
  label: string,
  check: () => A | undefined,
  timeout: Duration.Input,
  context: () => unknown,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(Duration.fromInputUnsafe(timeout));
    while (Date.now() < deadline) {
      const value = check();
      if (value !== undefined) return value;
      yield* Effect.sleep("250 millis");
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${label}: ${JSON.stringify(context(), null, 2)}`),
    );
  });

/** What the server published about the thread, for timeout messages. */
const lifecycle = (events: ReadonlyArray<ServerEvent>) =>
  events.flatMap((e) =>
    e.type === "thread.status" || e.type === "notify" || e.type === "thread.request" ? [e] : [],
  );

/** A temp git repo (with a commit, so worktrees can branch) and an RPC client with its events. */
const connect = Effect.gen(function* () {
  const repo = mkdtempSync(join(tmpdir(), "gram-live-"));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(repo, { recursive: true })));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "live test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=sb", "-c", "user.email=sb@example.invalid", "commit", "-qm", "init"],
    { cwd: repo },
  );

  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  const port = serverPort(server);
  const cookie = yield* bootCookie(port, token);
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
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
  const client = yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));

  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(client["events.subscribe"](), (e) => Effect.sync(() => void events.push(e))),
  );
  return { repo, client, events };
});

/** Waits for `threadId` to go idle after the events seen so far. */
const idleAfter = (events: ReadonlyArray<ServerEvent>, threadId: ThreadId, from: number) =>
  until(
    "the thread to go idle",
    () =>
      events
        .slice(from)
        .some(
          (e) => e.type === "thread.status" && e.threadId === threadId && e.status === "idle",
        ) || undefined,
    "180 seconds",
    () => lifecycle(events),
  );

/**
 * Waits for a turn started after `from` to finish: `running`, then `idle`. A fresh session reports
 * `idle` once it's ready, before the first prompt runs, so a bare idle isn't enough.
 */
const turnDone = (events: ReadonlyArray<ServerEvent>, threadId: ThreadId, from: number) =>
  until(
    "the turn to finish",
    () => {
      const statuses = events
        .slice(from)
        .flatMap((e) => (e.type === "thread.status" && e.threadId === threadId ? [e.status] : []));
      const running = statuses.indexOf("running");
      return (running !== -1 && statuses.slice(running + 1).includes("idle")) || undefined;
    },
    "180 seconds",
    () => lifecycle(events),
  );

const replyText = (message: GramUIMessage | undefined) =>
  (message?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe.skipIf(!LIVE)("live claude over the socket", () => {
  it.live(
    "streams an Explore subagent as a nested message that finishes before its parent card",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        writeFileSync(join(repo, "notes.md"), "# Notes\n");
        writeFileSync(join(repo, "index.ts"), "export const answer = 42;\n");

        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
        });
        const feed: Array<ThreadFeedEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(client["thread.subscribe"]({ threadId: thread.id }), (e) =>
            Effect.sync(() => void feed.push(e)),
          ),
        );
        yield* until(
          "the feed to catch up",
          () => feed.some((e) => e.type === "caughtUp") || undefined,
          "30 seconds",
          () => feed,
        );

        const mark = events.length;
        yield* client["thread.send"]({
          threadId: thread.id,
          input: {
            text: "Use the Task tool with subagent_type Explore and run_in_background true to list the files in this repo. When it reports back, reply DONE.",
          },
        });
        const topLevelText = () => {
          const topLevel = new Set(
            feed.flatMap((e) =>
              e.type === "chunk" &&
              e.chunk.type === "start" &&
              e.chunk.messageMetadata?.parentToolUseId === undefined
                ? [e.messageId]
                : [],
            ),
          );
          return feed
            .map((e) =>
              e.type === "chunk" && e.chunk.type === "text-delta" && topLevel.has(e.messageId)
                ? e.chunk.delta
                : "",
            )
            .join("");
        };
        // A backgrounded subagent reports back in a follow-up turn the agent starts on its own.
        yield* until(
          "the reply DONE",
          () => /\bDONE\b/.test(topLevelText()) || undefined,
          "240 seconds",
          () => lifecycle(events.slice(mark)),
        );
        yield* until(
          "the thread to settle",
          () => {
            const last = events.findLast(
              (e) => e.type === "thread.status" && e.threadId === thread.id,
            );
            return (last?.type === "thread.status" && last.status === "idle") || undefined;
          },
          "60 seconds",
          () => lifecycle(events.slice(mark)),
        );

        const chunks = feed.flatMap((e, index) => (e.type === "chunk" ? [{ ...e, index }] : []));
        const timeline = feed.flatMap((e, index) => {
          if (e.type !== "chunk" || e.chunk.type.endsWith("-delta")) return [];
          const c = e.chunk as { toolName?: string; output?: { status?: string } };
          return [
            `${index} ${e.messageId.slice(0, 8)} ${e.chunk.type}${c.toolName ? ` ${c.toolName}` : ""}${c.output?.status ? ` (${c.output.status})` : ""}`,
          ];
        });
        const statuses = events
          .slice(mark)
          .flatMap((e) =>
            e.type === "thread.status" && e.threadId === thread.id ? [e.status] : [],
          );
        console.log(
          `subagent timeline:\n${timeline.join("\n")}\nstatuses: ${statuses.join(" → ")}`,
        );
        const starts = chunks.flatMap((c) =>
          c.chunk.type === "start"
            ? [
                {
                  messageId: c.messageId,
                  parentToolUseId: c.chunk.messageMetadata?.parentToolUseId,
                },
              ]
            : [],
        );
        const parent = starts.find((s) => s.parentToolUseId === undefined);
        const call = chunks.find(
          (c) =>
            c.messageId === parent?.messageId &&
            c.chunk.type === "tool-input-available" &&
            (c.chunk.toolName === "Task" || c.chunk.toolName === "Agent"),
        );
        const context = () => chunks.map((c) => `${c.messageId} ${c.chunk.type}`);
        if (call?.chunk.type !== "tool-input-available") {
          return yield* Effect.die(new Error(`no Task/Agent call: ${JSON.stringify(context())}`));
        }
        const toolCallId = call.chunk.toolCallId;
        expect((call.chunk.input as { subagent_type?: string }).subagent_type).toBe("Explore");

        const subagent = starts.find((s) => s.parentToolUseId === toolCallId);
        expect(subagent, JSON.stringify(context())).toBeDefined();
        const on = (messageId: string, type: string) =>
          chunks.findIndex((c) => c.messageId === messageId && c.chunk.type === type);
        const subagentText = chunks
          .filter((c) => c.messageId === subagent!.messageId && c.chunk.type === "text-delta")
          .map((c) => (c.chunk.type === "text-delta" ? c.chunk.delta : ""))
          .join("");
        expect(subagentText.trim().length).toBeGreaterThan(0);

        const subagentFinished = on(subagent!.messageId, "finish");
        const cardOutput = chunks.find(
          (c) => c.chunk.type === "tool-output-available" && c.chunk.toolCallId === toolCallId,
        );
        const cardCompleted = cardOutput === undefined ? -1 : chunks.indexOf(cardOutput);
        const parentFinished = on(parent!.messageId, "finish");
        expect(subagentFinished).toBeGreaterThan(-1);
        expect(cardCompleted).toBeGreaterThan(-1);
        // The card gets a placeholder at once; the subagent streams afterwards and finishes when it
        // reports back.
        expect(
          cardOutput?.chunk.type === "tool-output-available" &&
            (cardOutput.chunk.output as { status?: string }).status,
        ).toBe("async_launched");
        const subagentTextAt = chunks.findIndex(
          (c) => c.messageId === subagent!.messageId && c.chunk.type === "text-delta",
        );
        expect(subagentTextAt).toBeGreaterThan(cardCompleted);
        expect(subagentFinished).toBeGreaterThan(subagentTextAt);
        expect(parentFinished).toBeGreaterThan(-1);

        // The thread ends idle, with no agent errors on the way.
        const since = events.slice(mark);
        expect(
          since.filter(
            (e) => e.type === "notify" && e.threadId === thread.id && e.kind === "error",
          ),
        ).toEqual([]);
        expect(
          since.some(
            (e) => e.type === "thread.status" && e.threadId === thread.id && e.status === "error",
          ),
        ).toBe(false);
        expect(chunks.filter((c) => c.chunk.type === "tool-output-error")).toEqual([]);
        expect(yield* runtimes.status(thread.id)).toBe("idle");

        const stored = yield* store.listMessages(thread.id);
        const nested = stored.filter((m) => m.metadata?.parentToolUseId === toolCallId);
        expect(nested).toHaveLength(1);
        expect(replyText(nested[0])).not.toBe("");
        const replies = stored.filter(
          (m) => m.role === "assistant" && m.metadata?.parentToolUseId === undefined,
        );
        expect(replyText(replies.at(-1)).toUpperCase()).toContain("DONE");
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    { timeout: 300_000, retry: 1 },
  );

  it.live(
    "creates a thread, approves one Bash call, and persists the conversation",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;

        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
          input: {
            // A write, so the command isn't auto-allowed as read-only and reaches the approval card.
            text: "Use the Bash tool to run `touch gram-live.txt`, then reply with the single word: done",
          },
        });

        const requestId = yield* until(
          "a Bash approval request",
          () => {
            for (const e of events) {
              if (e.type === "thread.request" && e.request.kind === "approval") {
                return e.request.id as RequestId;
              }
            }
            return undefined;
          },
          "120 seconds",
          () => lifecycle(events),
        );
        const requestIndex = events.findIndex((e) => e.type === "thread.request");
        yield* client["thread.respond"]({
          threadId: thread.id,
          requestId,
          answer: { kind: "approval", decision: "allow", scope: "once" },
        });
        yield* idleAfter(events, thread.id, requestIndex);
        expect(existsSync(join(repo, "gram-live.txt"))).toBe(true);

        const feed = yield* client["thread.subscribe"]({ threadId: thread.id }).pipe(
          Stream.takeUntil((e: ThreadFeedEvent) => e.type === "caughtUp"),
          Stream.runCollect,
        );
        const history = feed[0]?.type === "messages" ? feed[0].messages : [];
        expect(history.map((m) => m.role)).toContain("user");
        expect(history.some((m) => m.parts.some((p) => p.type === "tool-Bash"))).toBe(true);

        const stored = yield* store.listMessages(thread.id);
        expect(stored.length).toBeGreaterThanOrEqual(2);
        expect((yield* store.getThread(thread.id)).agentSessionId).toBeTypeOf("string");

        const { models } = yield* client["models.list"]({ agent: "claude" });
        expect(models.length).toBeGreaterThan(0);

        // A worktree thread: created through the git checkout service, then closed with removal.
        const worktree = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "newWorktree", branch: "gram-live" },
          model: HAIKU,
          mode: "default",
        });
        expect(worktree.checkout).toMatchObject({ kind: "worktree", branch: "gram-live" });
        expect(existsSync(worktree.checkout.path)).toBe(true);
        yield* until(
          "the worktree session",
          () =>
            events.some((e) => e.type === "thread.identity" && e.threadId === worktree.id) ||
            undefined,
          "60 seconds",
          () => lifecycle(events),
        );
        yield* client["thread.close"]({ threadId: worktree.id, removeWorktree: { force: true } });
        expect(existsSync(worktree.checkout.path)).toBe(false);
        // Events arrive on their own stream, possibly after the close reply.
        yield* until(
          "thread.removed for the worktree thread",
          () =>
            events.some((e) => e.type === "thread.removed" && e.threadId === worktree.id) ||
            undefined,
          "10 seconds",
          () => lifecycle(events),
        );
      }).pipe(
        // Close the client (and its open socket) before the server shuts down, or shutdown waits
        // for the connection to drain.
        Effect.scoped,
        Effect.provide(LiveServer),
      ),
    300_000,
  );

  it.live(
    "rewinds to after turn one, so the agent no longer remembers turn two",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;

        let mark = events.length;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
          input: { text: "Remember the codeword AMBER. Reply OK." },
        });
        yield* turnDone(events, thread.id, mark);

        mark = events.length;
        yield* client["thread.send"]({
          threadId: thread.id,
          input: { text: "The codeword is now BLUE. Reply OK." },
        });
        yield* turnDone(events, thread.id, mark);

        const beforeRewind = yield* store.listMessages(thread.id);
        expect(beforeRewind.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
        const [user1, reply1] = beforeRewind;
        expect(reply1!.metadata?.agentMessageIds?.length).toBeGreaterThan(0);

        const feed: Array<ThreadFeedEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(client["thread.subscribe"]({ threadId: thread.id }), (e) =>
            Effect.sync(() => void feed.push(e)),
          ),
        );
        yield* until(
          "the feed to catch up",
          () => feed.some((e) => e.type === "caughtUp") || undefined,
          "10 seconds",
          () => feed,
        );

        mark = events.length;
        yield* client["thread.rewind"]({
          threadId: thread.id,
          toMessageId: reply1!.id as MessageId,
          files: false,
        });
        const replaced = yield* until(
          "the feed to re-send the history",
          () => {
            const last = feed.findLast((e) => e.type === "messages");
            return last?.type === "messages" && last.messages.length === 2 ? last : undefined;
          },
          "10 seconds",
          () => feed.map((e) => e.type),
        );
        expect(replaced.messages.map((m) => m.id)).toEqual([user1!.id, reply1!.id]);
        yield* idleAfter(events, thread.id, mark);

        mark = events.length;
        yield* client["thread.send"]({
          threadId: thread.id,
          input: { text: "What is the codeword? One word." },
        });
        yield* turnDone(events, thread.id, mark);

        const answer = replyText((yield* store.listMessages(thread.id)).at(-1)).toUpperCase();
        expect(answer).toContain("AMBER");
        expect(answer).not.toContain("BLUE");
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    300_000,
  );

  it.live(
    "forks after turn one into a new worktree, so the fork knows AMBER but not BLUE",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;

        let mark = events.length;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
          input: { text: "Remember the codeword AMBER. Reply OK." },
        });
        yield* turnDone(events, thread.id, mark);

        mark = events.length;
        yield* client["thread.send"]({
          threadId: thread.id,
          input: { text: "The codeword is now BLUE. Reply OK." },
        });
        yield* turnDone(events, thread.id, mark);
        const [, reply1] = yield* store.listMessages(thread.id);

        // The source's session is still open, so the fork needs its own checkout.
        const fork = yield* client["thread.fork"]({
          threadId: thread.id,
          fromMessageId: reply1!.id as MessageId,
          checkout: { kind: "newWorktree", branch: "gram-live-fork" },
        });
        expect(fork.forkedFrom?.threadId).toBe(thread.id);
        expect((yield* store.listMessages(fork.id)).map((m) => m.role)).toEqual([
          "user",
          "assistant",
        ]);

        mark = events.length;
        yield* client["thread.send"]({
          threadId: fork.id,
          input: { text: "What is the codeword? One word." },
        });
        yield* turnDone(events, fork.id, mark);

        const answer = replyText((yield* store.listMessages(fork.id)).at(-1)).toUpperCase();
        expect(answer).toContain("AMBER");
        expect(answer).not.toContain("BLUE");
        const forked = yield* store.getThread(fork.id);
        expect(forked.agentSessionId).toBeTypeOf("string");
        expect(forked.agentSessionId).not.toBe((yield* store.getThread(thread.id)).agentSessionId);

        yield* client["thread.close"]({ threadId: fork.id, removeWorktree: { force: true } });
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    300_000,
  );

  it.live(
    "grants a folder mid-session, so Claude reads a file there without an approval card",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const outside = mkdtempSync(join(tmpdir(), "gram-live-grant-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(outside, { recursive: true })));
        const codewordFile = join(outside, "codeword.txt");
        writeFileSync(codewordFile, "The codeword is TANGERINE.\n");

        let mark = events.length;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
          input: { text: "Reply OK." },
        });
        yield* turnDone(events, thread.id, mark);
        const readCodeword = {
          threadId: thread.id,
          input: {
            text: `Use the Read tool to read ${codewordFile}. Reply with the codeword only.`,
          },
        };

        // No allow rule for Read on purpose: before the grant, reading outside the checkout asks.
        mark = events.length;
        yield* client["thread.send"](readCodeword);
        const card = yield* until(
          "the Read approval card before the grant",
          () => {
            for (const e of events.slice(mark)) {
              if (e.type === "thread.request" && e.threadId === thread.id) return e.request;
            }
            return undefined;
          },
          "180 seconds",
          () => lifecycle(events),
        );
        yield* client["thread.respond"]({
          threadId: thread.id,
          requestId: card.id as RequestId,
          answer: { kind: "approval", decision: "deny", scope: "once" },
        });
        yield* turnDone(events, thread.id, mark);

        // What `request_directory` does once the user allows its card.
        mark = events.length;
        const granted = yield* runtimes.addDirectories(thread.id, [outside]);
        expect(granted.additionalDirectories).toEqual([outside]);

        yield* client["thread.send"](readCodeword);
        // After the grant the same Read runs without a card, in the same session.
        const outcome = yield* until(
          "the Read to finish or ask for approval",
          () => {
            const since = events.slice(mark);
            if (since.some((e) => e.type === "thread.request" && e.threadId === thread.id)) {
              return "card" as const;
            }
            const statuses = since.flatMap((e) =>
              e.type === "thread.status" && e.threadId === thread.id ? [e.status] : [],
            );
            const running = statuses.indexOf("running");
            return running !== -1 && statuses.slice(running + 1).includes("idle")
              ? ("done" as const)
              : undefined;
          },
          "180 seconds",
          () => lifecycle(events),
        );
        if (outcome === "card") yield* client["thread.interrupt"]({ threadId: thread.id });
        expect(outcome).toBe("done");
        // Applied live rather than by reopening the session.
        expect(
          events
            .slice(mark)
            .some(
              (e) =>
                e.type === "thread.status" && e.threadId === thread.id && e.status === "starting",
            ),
        ).toBe(false);
        const answer = replyText((yield* store.listMessages(thread.id)).at(-1)).toUpperCase();
        expect(answer).toContain("TANGERINE");
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    300_000,
  );

  it.live(
    "Allow always keeps a Bash rule for the rest of the session",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;
        const command = "touch gram-always.txt";

        let mark = events.length;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: HAIKU,
          mode: "default",
          input: {
            text: `Use the Bash tool to run \`${command}\`, then reply with the single word: done`,
          },
        });
        const card = yield* until(
          "the Bash approval card",
          () => {
            for (const e of events.slice(mark)) {
              if (e.type === "thread.request" && e.threadId === thread.id) return e.request;
            }
            return undefined;
          },
          "120 seconds",
          () => lifecycle(events),
        );
        yield* client["thread.respond"]({
          threadId: thread.id,
          requestId: card.id as RequestId,
          answer: { kind: "approval", decision: "allow", scope: "always" },
        });
        yield* turnDone(events, thread.id, mark);
        expect(existsSync(join(repo, "gram-always.txt"))).toBe(true);
        // Written where Claude Code keeps project-local rules.
        const localSettings = join(repo, ".claude", "settings.local.json");
        expect(existsSync(localSettings) ? readFileSync(localSettings, "utf8") : "").toContain(
          "touch",
        );

        // The same command later in the session runs without asking again.
        mark = events.length;
        yield* client["thread.send"]({
          threadId: thread.id,
          input: {
            text: `Use the Bash tool to run \`${command}\` once more, then reply with the single word: done`,
          },
        });
        yield* turnDone(events, thread.id, mark);
        expect(
          events.slice(mark).filter((e) => e.type === "thread.request" && e.threadId === thread.id),
        ).toEqual([]);
        const last = (yield* store.listMessages(thread.id)).at(-1);
        expect(last?.parts.some((p) => p.type === "tool-Bash")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    300_000,
  );

  it.live(
    "an effort change mid-session applies from the next turn",
    () =>
      Effect.gen(function* () {
        const { repo, client, events } = yield* connect;
        const store = yield* ThreadStore;
        const probe =
          "Use the Bash tool to run `echo effort=$CLAUDE_EFFORT`, then reply with its output only.";

        /** Waits for the turn to end, allowing any approval card once on the way. */
        const settle = (threadId: ThreadId, from: number) =>
          Effect.gen(function* () {
            const answered = new Set<string>();
            for (let i = 0; i < 4; i++) {
              const next = yield* until(
                "the turn to finish or ask",
                () => {
                  const since = events.slice(from);
                  for (const e of since) {
                    if (e.type === "thread.request" && e.threadId === threadId) {
                      if (!answered.has(e.request.id)) return { card: e.request.id as RequestId };
                    }
                  }
                  const statuses = since.flatMap((e) =>
                    e.type === "thread.status" && e.threadId === threadId ? [e.status] : [],
                  );
                  const running = statuses.indexOf("running");
                  return running !== -1 && statuses.slice(running + 1).includes("idle")
                    ? { done: true }
                    : undefined;
                },
                "180 seconds",
                () => lifecycle(events),
              );
              if ("done" in next) return;
              answered.add(next.card);
              yield* client["thread.respond"]({
                threadId,
                requestId: next.card,
                answer: { kind: "approval", decision: "allow", scope: "once" },
              });
            }
          });

        let mark = events.length;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
          model: sonnetAt("low"),
          mode: "default",
          input: { text: probe },
        });
        yield* settle(thread.id, mark);
        expect(replyText((yield* store.listMessages(thread.id)).at(-1))).toContain("effort=low");

        yield* client["thread.setModel"]({ threadId: thread.id, model: sonnetAt("high") });
        mark = events.length;
        yield* client["thread.send"]({ threadId: thread.id, input: { text: probe } });
        yield* settle(thread.id, mark);
        expect(replyText((yield* store.listMessages(thread.id)).at(-1))).toContain("effort=high");
      }).pipe(Effect.scoped, Effect.provide(LiveServer)),
    300_000,
  );
});
