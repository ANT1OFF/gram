import { describe, expect, it } from "@effect/vitest";
import { makeMapper as makeClaudeMapper } from "@gram/agents/claude";
import { fixtureMessages as claudeFixture } from "@gram/agents/claude/testing";
import { makeCodexMapper, type CodexMapper } from "@gram/agents/codex";
import { codexFixture } from "@gram/agents/codex/testing";
import {
  MessageId,
  type AgentEvent,
  type ServerEvent,
  type ThreadStatus,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentsDir, readThreadAttachment } from "../attachments/attachments.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { makeRuntimeTestLayer, RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { BACKGROUND_SETTLE, ThreadRuntimes } from "./thread-runtimes.ts";

/** A recording as the runtime sees it: our sends, and what the adapter emitted in between. */
type Step =
  | { readonly kind: "send" }
  | { readonly kind: "events"; readonly events: ReadonlyArray<AgentEvent> };

const messageIds = () => {
  let n = 0;
  return () => MessageId.make(`m${++n}`);
};

const fixtureNames = (agent: string, extension: string) =>
  readdirSync(new URL(`../../../agents/fixtures/${agent}/`, import.meta.url))
    .filter((file) => file.endsWith(extension))
    .map((file) => file.slice(0, -extension.length));

/** Codex recordings mark our sends: every `turn/start` the recorder sent. */
const codexSteps = (name: string): Array<Step> => {
  const mapper = makeCodexMapper({ newMessageId: messageIds() });
  const steps: Array<Step> = [];
  for (const { dir, msg } of codexFixture(name).messages) {
    if (dir === "out" && msg["method"] === "turn/start") {
      steps.push({ kind: "send" });
    } else if (dir === "in" && typeof msg["method"] === "string" && !("id" in msg)) {
      const notification = msg as unknown as Parameters<CodexMapper["map"]>[0];
      steps.push({ kind: "events", events: mapper.map(notification) });
    }
  }
  return steps;
};

const QUIET: ReadonlySet<ThreadStatus> = new Set(["cold", "starting", "idle", "error", "ended"]);

/**
 * Plays `steps` into a runtime, sending where the recording sent, and checks that turns open only
 * with our sends: the thread never goes from quiet to running on the adapter's say-so alone.
 */
const replay = (
  steps: ReadonlyArray<Step>,
  input: UserInput = { text: "go" },
  root = "/work/repo",
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const fake = yield* FakeAgentControl;
    const published: Array<ServerEvent> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(
        hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
        (event) => Effect.sync(() => void published.push(event)),
      ),
    );
    yield* waitFor(
      "the subscription",
      Effect.sync(() => published.length > 0),
    );

    // Creating with a prompt is the recording's first send.
    const thread = yield* runtimes.create({
      projectRoot: root,
      checkout: { kind: "main", path: root },
      input,
    });
    const session = yield* waitFor(
      "the session",
      fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    let sends = 1;
    let firstSend = true;
    for (const step of steps) {
      if (step.kind === "events") {
        yield* session.emit(...step.events);
        continue;
      }
      if (firstSend) {
        firstSend = false;
        continue;
      }
      yield* waitFor(
        "idle before the next send",
        runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
      );
      yield* runtimes.send(thread.id, { text: "go" });
      sends++;
      yield* waitFor(
        "the send",
        Effect.sync(() => session.sent.length === sends),
      );
    }
    const statusesSoFar = () =>
      published.flatMap((event) =>
        event.type === "thread.status" && event.threadId === thread.id ? [event.status] : [],
      );
    // A recorded tool image is written to disk mid-turn, and `yieldNow` doesn't move a fiber parked
    // on real I/O along: Windows CI reached the assertions with the turn still open. Real time,
    // since `it.effect`'s clock is the test clock.
    for (let i = 0; i < 2000 && statusesSoFar().at(-1) === "running"; i++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    for (let i = 0; i < 500; i++) yield* Effect.yieldNow;

    const statuses = statusesSoFar();
    const turnStarts = statuses.filter(
      (status, i) => status === "running" && (i === 0 || QUIET.has(statuses[i - 1]!)),
    );
    expect(turnStarts).toHaveLength(sends);
    expect(yield* store.listTurns(thread.id)).toHaveLength(sends);
    expect(statuses.at(-1)).not.toBe("running");
    return thread.id;
  });

describe("recorded adapter sessions through the runtime", () => {
  it.effect(
    "synthetic Codex image views and MCP images survive runtime persistence with safe attachment serving",
    () => {
      const dataDir = mkdtempSync(
        join(process.platform === "darwin" ? "/tmp" : tmpdir(), "gram-codex-images-"),
      );
      const root = join(dataDir, "checkout");
      mkdirSync(root);
      const path = join(dataDir, "attached.png");
      const other = join(dataDir, "board-icon-alignment-working-after.png");
      const workspace = join(root, "workspace.png");
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      writeFileSync(path, Buffer.from(png, "base64"));
      writeFileSync(other, Buffer.from(png, "base64"));
      writeFileSync(workspace, Buffer.from(png, "base64"));
      const mapper = makeCodexMapper({ newMessageId: messageIds() });
      const notify = (method: string, params: unknown) =>
        mapper.map({ method, params } as Parameters<CodexMapper["map"]>[0]);
      const wrapper = {
        type: "dynamicToolCall",
        id: "wrapper",
        namespace: "functions",
        tool: "exec",
        arguments: {
          code: `const r = await tools.view_image({path: ${JSON.stringify(other)}}); image(r.image_url);`,
        },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      const events = [
        ...notify("item/started", { threadId: "cx-thread", turnId: "cx-turn", item: wrapper }),
        ...notify("item/completed", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          completedAtMs: 1,
          item: { type: "imageView", id: "view", path },
        }),
        ...notify("item/completed", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          completedAtMs: 1,
          item: { type: "imageView", id: "workspace", path: workspace },
        }),
        ...notify("item/started", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          startedAtMs: 1,
          item: { type: "imageView", id: "unrelated", path: other },
        }),
        ...notify("item/completed", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          completedAtMs: 2,
          item: { type: "imageView", id: "unrelated", path: other },
        }),
        ...notify("item/completed", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          completedAtMs: 2,
          item: {
            ...wrapper,
            status: "completed",
            success: true,
            durationMs: 1,
            contentItems: [
              { type: "inputText", text: JSON.stringify({ type: "image", path: other }) },
            ],
          },
        }),
        ...notify("item/completed", {
          threadId: "cx-thread",
          turnId: "cx-turn",
          completedAtMs: 3,
          item: {
            type: "mcpToolCall",
            id: "mcp-image",
            server: "synthetic",
            tool: "view_image",
            status: "completed",
            arguments: {},
            appContext: null,
            mcpAppUi: null,
            pluginId: null,
            readOnlyHint: true,
            error: null,
            durationMs: 1,
            result: {
              content: [
                { type: "image", mimeType: "image/png", data: png },
                { type: "text", text: "Image metadata" },
              ],
              structuredContent: { width: 1 },
              _meta: null,
            },
          },
        }),
        ...notify("turn/completed", {
          threadId: "cx-thread",
          turn: { id: "cx-turn", status: "completed", items: [], error: null },
        }),
      ];
      return Effect.gen(function* () {
        const threadId = yield* replay(
          [{ kind: "send" }, { kind: "events", events }],
          {
            text: "Read the synthetic image",
            attachments: [{ path, name: "attached.png", mediaType: "image/png" }],
          },
          root,
        );
        const messages = yield* (yield* ThreadStore).listMessages(threadId);
        const parts = messages.flatMap((m) => m.parts);
        expect(parts.find((p) => "toolCallId" in p && p.toolCallId === "view")).toMatchObject({
          type: "dynamic-tool",
          state: "output-available",
          output: { type: "image", path },
        });
        expect((yield* readThreadAttachment(messages, path)).base64).toBe(png);
        // The native read grants a saved snapshot, never serving access to its original path.
        expect(yield* readThreadAttachment(messages, other).pipe(Effect.flip)).toMatchObject({
          _tag: "InvalidState",
        });
        expect(JSON.stringify(messages)).not.toContain(png);
        const snapshots = parts.filter((p) => p.type === "data-tool-image");
        expect(snapshots.map((p) => p.data.toolCallId)).toEqual([
          "view",
          "workspace",
          "unrelated",
          "mcp-image",
        ]);
        const external = snapshots.find((p) => p.data.toolCallId === "unrelated");
        expect(external?.data.path).toBeDefined();
        yield* Effect.sync(() => rmSync(other));
        expect((yield* readThreadAttachment(messages, external!.data.path!)).base64).toBe(png);
        expect(
          yield* readThreadAttachment([], external!.data.path!).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidState" });
        const snapshot = snapshots.find((p) => p.data.toolCallId === "workspace");
        expect(snapshot?.data.path).toBeDefined();
        yield* Effect.sync(() => rmSync(workspace));
        const restored = JSON.parse(JSON.stringify(messages));
        expect((yield* readThreadAttachment(restored, snapshot!.data.path!)).base64).toBe(png);
        expect(
          yield* readThreadAttachment([], snapshot!.data.path!).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidState" });
        const image = snapshots.find((p) => p.data.toolCallId === "mcp-image");
        expect(image?.data.toolCallId).toBe("mcp-image");
        expect((yield* readThreadAttachment(messages, image!.data.path!)).base64).toBe(png);
        expect(parts.find((p) => "toolCallId" in p && p.toolCallId === "mcp-image")).toMatchObject({
          output: {
            content: [
              { type: "image", mimeType: "image/png" },
              { type: "text", text: "Image metadata" },
            ],
            structuredContent: { width: 1 },
          },
        });
      }).pipe(
        Effect.provide(
          makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
            ...TEST_CONFIG,
            dataDir,
          }),
        ),
        Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
      );
    },
  );

  for (const name of fixtureNames("codex", ".json")) {
    const steps = codexSteps(name);
    // A status-only recording (e.g. MCP server status) has no turn to open.
    if (!steps.some((step) => step.kind === "send")) continue;
    it.effect(`codex ${name} opens a turn only with our sends`, () =>
      replay(steps).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect(
    "keeps a compaction's marker in the stored transcript, in the turn it happened in",
    () =>
      Effect.gen(function* () {
        for (const steps of [codexSteps("cx15-auto-compact")]) {
          const threadId = yield* replay(steps);
          const messages = yield* (yield* ThreadStore).listMessages(threadId);
          const marked = messages.filter((message) =>
            message.parts.some((part) => part.type === "data-compaction"),
          );
          expect(marked).toHaveLength(1);
          // The second turn's reply, where the agent compacted before it went on.
          expect(marked[0]).toBe(messages.filter((message) => message.role === "assistant")[1]);
        }
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("holds a pending MCP restart through Claude's report on a finished shell", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const mapper = makeClaudeMapper({ newMessageId: messageIds(), now: () => 0 });
      const messages = claudeFixture("p14-background-shells");
      // The last shell leaves the list while the thread is idle, and the report starts after it.
      const emptied = messages.findIndex(
        (m) =>
          m.type === "system" && "tasks" in m && Array.isArray(m.tasks) && m.tasks.length === 0,
      );
      const running = messages.findIndex(
        (m, i) => i > emptied && m.type === "system" && "state" in m && m.state === "running",
      );
      const events = (from: number, to?: number) =>
        messages.slice(from, to).flatMap((m) => mapper.map(m));
      const firstTurn = events(0, emptied);
      const shellDone = events(emptied, running);
      const reportStarts = events(running, running + 1);
      const report = events(running + 1);

      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "go" },
      });
      const session = yield* waitFor(
        "the session",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.emit(...firstTurn);
      const shellRunning = runtimes.snapshot.pipe(
        Effect.map((all) =>
          all.some((s) => s.thread.id === thread.id && s.status === "idle" && s.background),
        ),
      );
      yield* waitFor("idle with the shell running", shellRunning);
      expect(yield* runtimes.mcpConfigChanged({ agent: "claude" })).toEqual([thread.id]);

      yield* session.emit(...shellDone);
      yield* session.emit(...reportStarts);
      yield* TestClock.adjust(BACKGROUND_SETTLE);
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);

      yield* session.emit(...report);
      yield* waitFor(
        "the restart after the report",
        Effect.sync(() => fake.sessions.length === 2),
      );
      expect(session.closed).toBe(true);
      const turns = yield* (yield* ThreadStore).listTurns(thread.id);
      expect(turns.map((t) => t.reason)).toEqual(["completed", "completed"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

// Regressions retained from independent exact-6855948 review; invented local files only.

for (const scenario of ["orphan", "late"]) {
  it.effect(`independent source capture rejects ${scenario} events`, () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gram-review-event-"));
    const root = join(dataDir, "checkout");
    mkdirSync(root);
    const path = join(root, "shot.png");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    writeFileSync(path, Buffer.from(png, "base64"));
    const mapper = makeCodexMapper({ newMessageId: messageIds() });
    const notify = (method: string, params: unknown) =>
      mapper.map({ method, params } as Parameters<CodexMapper["map"]>[0]);
    const completion = () =>
      notify("item/completed", {
        threadId: "provider-thread",
        turnId: "A",
        completedAtMs: 1,
        item: { type: "imageView", id: "view", path },
      });
    const end = () =>
      notify("turn/completed", {
        threadId: "provider-thread",
        turn: { id: "A", status: "completed", error: null },
      });
    const events: AgentEvent[] =
      scenario === "orphan"
        ? [
            {
              type: "toolImageSource",
              origin: "codex-image-view",
              messageId: MessageId.make("orphan"),
              toolCallId: "never-started",
              path,
            },
            { type: "turnEnd", reason: "completed" },
            { type: "status", status: "idle" },
          ]
        : [...completion(), ...end(), ...completion(), ...end()];
    return Effect.gen(function* () {
      const id = yield* replay(
        [{ kind: "send" }, { kind: "events", events }],
        { text: "go" },
        root,
      );
      const messages = yield* (yield* ThreadStore).listMessages(id);
      const images = messages.flatMap((m) => m.parts).filter((p) => p.type === "data-tool-image");
      expect(images).toHaveLength(scenario === "orphan" ? 0 : 1);
      const files = yield* Effect.sync(() => {
        try {
          return readdirSync(join(attachmentsDir(dataDir), id));
        } catch {
          return [];
        }
      });
      expect(files).toHaveLength(scenario === "orphan" ? 0 : 1);
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
          ...TEST_CONFIG,
          dataDir,
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });
}

for (const scenario of [
  "source-alone",
  "missing-origin",
  "wrong-admission-message",
  "conflicting-admission",
  "late-admission",
  "non-provider",
  "wrong-message",
  "wrong-call",
  "wrong-path",
  "completed-call",
  "duplicate",
  "duplicate-admission",
  "finished-message",
  "nested",
  "other-agent",
  "other-tool",
  "ended-turn",
]) {
  it.effect(`native image source admission rejects ${scenario} events without new files`, () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gram-image-admission-"));
    const root = join(dataDir, "checkout");
    mkdirSync(root);
    const path = join(dataDir, "shot.png");
    const alternate = join(dataDir, "alternate.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(path, png);
    writeFileSync(alternate, Buffer.concat([png, Buffer.from("invented alternate")]));
    const messageId = MessageId.make("native-reply");
    const source: AgentEvent = {
      type: "toolImageSource",
      origin: "codex-image-view",
      messageId,
      toolCallId: "view",
      path,
    };
    const admission: AgentEvent = { ...source, type: "toolImageRead" };
    const admissions: AgentEvent[] =
      scenario === "source-alone"
        ? []
        : scenario === "wrong-admission-message"
          ? [{ ...admission, messageId: MessageId.make("unknown") }]
          : scenario === "conflicting-admission"
            ? [
                admission,
                {
                  type: "chunk",
                  messageId,
                  chunk: {
                    type: "tool-input-available",
                    toolName: "Read",
                    toolCallId: "view",
                    input: { file_path: alternate },
                    dynamic: true,
                    providerExecuted: true,
                  },
                },
                { ...admission, path: alternate },
              ]
            : scenario === "late-admission"
              ? [{ type: "turnEnd", reason: "completed" }, admission]
              : scenario === "duplicate-admission"
                ? [admission, admission]
                : [admission];
    const initial: AgentEvent[] = [
      {
        type: "chunk",
        messageId,
        chunk: {
          type: "start",
          messageId,
          messageMetadata: {
            agent: scenario === "other-agent" ? "claude" : "codex",
            ...(scenario === "nested" ? { parentToolUseId: "parent" } : {}),
          },
        },
      },
      {
        type: "chunk",
        messageId,
        chunk: {
          type: "tool-input-available",
          toolName: scenario === "other-tool" ? "Bash" : "Read",
          toolCallId: "view",
          input: { file_path: path },
          dynamic: true,
          providerExecuted: scenario !== "non-provider",
        },
      },
    ];
    const output: AgentEvent = {
      type: "chunk",
      messageId,
      chunk: {
        type: "tool-output-available",
        toolCallId: "view",
        output: { type: "image", path },
        dynamic: true,
        providerExecuted: true,
      },
    };
    const end: AgentEvent = { type: "turnEnd", reason: "completed" };
    const invalid: AgentEvent[] =
      scenario === "conflicting-admission"
        ? [{ ...source, path: alternate }]
        : scenario === "missing-origin"
          ? [{ ...source, origin: undefined } as unknown as AgentEvent]
          : scenario === "duplicate"
            ? [source, source]
            : scenario === "wrong-message"
              ? [{ ...source, messageId: MessageId.make("unknown") }]
              : scenario === "wrong-call"
                ? [{ ...source, toolCallId: "unknown" }]
                : scenario === "wrong-path"
                  ? [{ ...source, path: alternate }]
                  : scenario === "completed-call"
                    ? [output, source]
                    : scenario === "finished-message"
                      ? [{ type: "chunk", messageId, chunk: { type: "finish" } }, source]
                      : scenario === "ended-turn"
                        ? [end, source]
                        : [source];
    return Effect.gen(function* () {
      const id = yield* replay(
        [
          { kind: "send" },
          {
            kind: "events",
            events: [
              ...initial,
              ...admissions,
              ...invalid,
              output,
              end,
              { type: "status", status: "idle" },
            ],
          },
        ],
        { text: "go" },
        root,
      );
      const messages = yield* (yield* ThreadStore).listMessages(id);
      const images = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "data-tool-image");
      const expected = scenario === "duplicate" || scenario === "duplicate-admission" ? 1 : 0;
      expect(images).toHaveLength(expected);
      const files = yield* Effect.sync(() => {
        try {
          return readdirSync(join(attachmentsDir(dataDir), id));
        } catch {
          return [];
        }
      });
      expect(files).toHaveLength(expected);
      if (expected === 1)
        expect((yield* readThreadAttachment(messages, images[0]!.data.path!)).base64).toBe(
          png.toString("base64"),
        );
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
          ...TEST_CONFIG,
          dataDir,
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });
}

it.effect(
  "native snapshots stay owned across a retained command, reused call ID and newer turn",
  () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gram-image-background-integration-"));
    const root = join(dataDir, "checkout");
    mkdirSync(root);
    const pathA = join(root, "first.png");
    const pathB = join(root, "second.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const other = Buffer.concat([png, Buffer.from("invented second image")]);
    writeFileSync(pathA, png);
    writeFileSync(pathB, other);
    const mapper = makeCodexMapper({ threadId: "provider", newMessageId: messageIds() });
    const notify = (method: string, params: unknown) =>
      mapper.map({ method, params } as Parameters<CodexMapper["map"]>[0]);
    const image = (turnId: string, id: string, path: string) =>
      notify("item/completed", {
        threadId: "provider",
        turnId,
        completedAtMs: 1,
        item: { type: "imageView", id, path },
      });
    const end = (id: string) =>
      notify("turn/completed", {
        threadId: "provider",
        turn: {
          id,
          rootTurnId: null,
          status: "completed",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    const command = {
      type: "commandExecution",
      id: "command",
      pluginId: null,
      scriptPath: null,
      command: "invented command",
      cwd: root,
      source: "unifiedExecStartup",
      processId: "synthetic-process",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const initial = [
      ...image("A", "shared-view", pathA),
      ...notify("item/started", {
        threadId: "provider",
        turnId: "A",
        startedAtMs: 1,
        item: command,
      }),
      ...end("A"),
    ];
    const continued = notify("item/commandExecution/outputDelta", {
      threadId: "provider",
      turnId: "A",
      itemId: "command",
      delta: "continued\n",
    });
    expect(image("A", "shared-view", pathB)).toEqual([]);
    const newer = image("B", "shared-view", pathB);
    expect(image("A", "unowned-late-read", pathB)).toEqual([]);
    const final = [
      ...newer,
      ...notify("item/commandExecution/outputDelta", {
        threadId: "provider",
        turnId: "A",
        itemId: "command",
        delta: "exited\n",
      }),
      ...notify("item/completed", {
        threadId: "provider",
        turnId: "A",
        completedAtMs: 2,
        item: { ...command, status: "completed", exitCode: 0 },
      }),
      ...end("B"),
    ];
    return Effect.gen(function* () {
      const id = yield* replay(
        [
          { kind: "send" },
          { kind: "events", events: initial },
          { kind: "events", events: continued },
          { kind: "send" },
          { kind: "events", events: final },
        ],
        { text: "go" },
        root,
      );
      const messages = yield* (yield* ThreadStore).listMessages(id);
      const assistant = messages.filter((message) => message.role === "assistant");
      expect(assistant).toHaveLength(2);
      expect(assistant.map((message) => message.metadata?.agentMessageIds)).toEqual([["A"], ["B"]]);
      const firstCalls = assistant[0]!.parts.filter(
        (part) => part.type === "dynamic-tool" && part.toolCallId === "command",
      );
      expect(firstCalls).toHaveLength(1);
      expect(firstCalls[0]).toMatchObject({
        state: "output-available",
        output: { stdout: "continued\nexited\n" },
      });
      expect(firstCalls[0]).not.toHaveProperty("preliminary", true);
      expect(
        assistant[1]!.parts.some(
          (part) => part.type === "dynamic-tool" && part.toolCallId === "command",
        ),
      ).toBe(false);
      const images = assistant
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "data-tool-image");
      expect(images.map((part) => part.data.toolCallId)).toEqual(["shared-view", "shared-view"]);
      expect(readdirSync(join(attachmentsDir(dataDir), id))).toHaveLength(2);
      rmSync(pathA);
      rmSync(pathB);
      const restored = JSON.parse(JSON.stringify(messages));
      expect((yield* readThreadAttachment(restored, images[0]!.data.path!)).base64).toBe(
        png.toString("base64"),
      );
      expect((yield* readThreadAttachment(restored, images[1]!.data.path!)).base64).toBe(
        other.toString("base64"),
      );
      expect(
        yield* readThreadAttachment([], images[0]!.data.path!).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState" });
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
          ...TEST_CONFIG,
          dataDir,
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  },
);

for (const kind of ["dynamicToolCall", "mcpToolCall"] as const) {
  it.effect(
    `generic ${kind} Read plus a forged native-origin source cannot capture an external path`,
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), "gram-image-forged-origin-"));
      const root = join(dataDir, "checkout");
      mkdirSync(root);
      const path = join(dataDir, "unread.png");
      writeFileSync(
        path,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const messageId = MessageId.make("generic-read");
      const mapper = makeCodexMapper({ newMessageId: () => messageId, threadId: "provider" });
      const item =
        kind === "dynamicToolCall"
          ? {
              type: kind,
              id: "read",
              namespace: null,
              tool: "Read",
              arguments: { file_path: path },
              status: "inProgress",
              contentItems: null,
              success: null,
              durationMs: null,
            }
          : {
              type: kind,
              id: "read",
              server: "codex",
              tool: "view_image",
              arguments: { file_path: path },
              status: "inProgress",
              appContext: null,
              mcpAppUi: null,
              pluginId: null,
              readOnlyHint: true,
              result: null,
              error: null,
              durationMs: null,
            };
      const notify = (method: string, notifiedItem: unknown) =>
        mapper.map({
          method,
          params: {
            threadId: "provider",
            turnId: "turn",
            item: notifiedItem,
            startedAtMs: 1,
            completedAtMs: 1,
          },
        } as Parameters<CodexMapper["map"]>[0]);
      const started = notify("item/started", item);
      const completed = notify("item/completed", {
        ...item,
        status: "completed",
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ type: "image", path }) }],
        result: {
          content: [{ type: "text", text: JSON.stringify({ type: "image", path }) }],
          structuredContent: { type: "image", path },
          _meta: null,
        },
      });
      expect(
        [...started, ...completed].filter(
          (e) => e.type === "toolImageRead" || e.type === "toolImageSource",
        ),
      ).toEqual([]);
      return Effect.gen(function* () {
        const id = yield* replay(
          [
            { kind: "send" },
            {
              kind: "events",
              events: [
                ...started,
                {
                  type: "toolImageSource",
                  origin: "codex-image-view",
                  messageId,
                  toolCallId: "read",
                  path,
                },
                ...completed,
                { type: "turnEnd", reason: "completed" },
                { type: "status", status: "idle" },
              ],
            },
          ],
          { text: "synthetic only" },
          root,
        );
        const messages = yield* (yield* ThreadStore).listMessages(id);
        expect(
          messages.flatMap((m) => m.parts).filter((p) => p.type === "data-tool-image"),
        ).toEqual([]);
        expect(yield* readThreadAttachment(messages, path).pipe(Effect.flip)).toMatchObject({
          _tag: "InvalidState",
        });
        expect(existsSync(attachmentsDir(dataDir))).toBe(false);
      }).pipe(
        Effect.provide(
          makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
            ...TEST_CONFIG,
            dataDir,
          }),
        ),
        Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
      );
    },
  );
}
