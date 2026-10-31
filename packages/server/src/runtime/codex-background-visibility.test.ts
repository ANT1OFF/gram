import { readFileSync } from "node:fs";
import { makeCodexMapper, CODEX_CAPABILITIES } from "@gram/agents/codex";
import { MessageId, type GramUIMessage, type GramUIMessageChunk } from "@gram/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

type Notification = Parameters<ReturnType<typeof makeCodexMapper>["map"]>[0];
type Item = Extract<Notification, { method: "item/completed" }>["params"]["item"];
type Turn = Extract<Notification, { method: "turn/completed" }>["params"]["turn"];
const displayed = JSON.parse(
  readFileSync(
    new URL("../../../../apps/web/src/thread/codex-background.fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  background: GramUIMessage;
  completed: GramUIMessage;
  collaboration: GramUIMessage;
  retainedReplay: GramUIMessageChunk[];
};
const turn = (id = "parent-turn", status: Turn["status"] = "completed"): Turn => ({
  id,
  rootTurnId: null,
  items: [],
  itemsView: "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1_000,
});
const command = (extra: Partial<Extract<Item, { type: "commandExecution" }>> = {}): Item => ({
  type: "commandExecution",
  id: "command-1",
  pluginId: null,
  scriptPath: null,
  command: "printf ready; sleep 30; printf done",
  cwd: "/synthetic/project",
  source: "unifiedExecStartup",
  processId: "pty-1",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra,
});
const item = (
  method: "item/started" | "item/completed",
  value: Item,
  turnId = "parent-turn",
): Notification =>
  method === "item/started"
    ? { method, params: { threadId: "provider-parent", turnId, item: value, startedAtMs: 1_000 } }
    : {
        method,
        params: { threadId: "provider-parent", turnId, item: value, completedAtMs: 2_000 },
      };
const delta = (text: string, turnId = "parent-turn", itemId = "command-1"): Notification => ({
  method: "item/commandExecution/outputDelta",
  params: { threadId: "provider-parent", turnId, itemId, delta: text },
});
const end = (status: Turn["status"] = "completed"): Notification => ({
  method: "turn/completed",
  params: { threadId: "provider-parent", turn: turn("parent-turn", status) },
});
const idle: Notification = {
  method: "thread/status/changed",
  params: { threadId: "provider-parent", status: { type: "idle" } },
};
const setup = () => {
  let count = 0;
  const mapper = makeCodexMapper({
    threadId: "provider-parent",
    now: () => 1_000,
    newMessageId: () => MessageId.make(count++ === 0 ? "codex-parent" : `message-${count}`),
  });
  const acc = new MessageAccumulator("codex-parent");
  const notify = (notification: Notification) => {
    const events = mapper.map(notification);
    for (const event of events)
      if (event.type === "chunk" && event.messageId === "codex-parent") acc.apply(event.chunk);
    return events;
  };
  return { mapper, acc, notify };
};

it.each(["completed", "interrupted"] as const)(
  "keeps the known PTY after parent %s and updates the original card on exit",
  (status) => {
    const { notify, acc } = setup();
    notify(item("item/started", command()));
    notify(delta("ready\n"));
    notify(idle);
    const ended = notify(end(status));
    expect(ended).toContainEqual({
      type: "backgroundTasks",
      tasks: [
        {
          taskId: JSON.stringify(["parent-turn", "command-1"]),
          kind: "shell",
          description: "printf ready; sleep 30; printf done",
          command: "printf ready; sleep 30; printf done",
          toolCallId: "command-1",
          startedAt: 1_000,
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(acc.snapshot()))).toEqual(displayed.background);
    expect(ended.some((e) => e.type === "chunk" && e.chunk.type === "tool-output-error")).toBe(
      false,
    );
    const progress = notify(delta("done\n"));
    expect(progress.map((e) => e.type === "chunk" && e.chunk.type)).toEqual([
      "tool-output-available",
      "finish",
    ]);
    const exit = item(
      "item/completed",
      command({ status: "completed", aggregatedOutput: "ready\ndone\n", exitCode: 0 }),
    );
    const finished = notify(exit);
    expect(finished).toContainEqual({ type: "backgroundTasks", tasks: [] });
    expect(JSON.parse(JSON.stringify(acc.snapshot()))).toEqual(displayed.completed);
    expect(
      finished.some(
        (e) => e.type === "turnEnd" || (e.type === "chunk" && e.chunk.type === "start"),
      ),
    ).toBe(false);
    expect(notify(exit)).toEqual([]);
    expect(notify(delta("duplicate"))).toEqual([]);
  },
);

it("does not let unknown, wrong-turn, child-thread or wrong-process events acquire a background command", () => {
  const { notify, acc } = setup();
  expect(notify(delta("unknown"))).toEqual([]);
  notify(item("item/started", command()));
  notify(delta("ready\n"));
  notify(end());
  expect(notify(delta("wrong turn", "another-turn"))).toEqual([]);
  expect(notify(delta("wrong item", "parent-turn", "unknown"))).toEqual([]);
  const child = delta("child output");
  expect(
    notify({ ...child, params: { ...child.params, threadId: "provider-child" } } as Notification),
  ).toEqual([]);
  expect(
    notify(item("item/completed", command({ status: "completed", processId: "wrong-process" }))),
  ).toEqual([]);
  expect(JSON.parse(JSON.stringify(acc.snapshot()))).toEqual(displayed.background);
});

it("does not infer a background process from a generic unfinished command, and closes known tasks on owner exit", () => {
  const generic = setup();
  generic.notify(item("item/started", command({ source: "agent", processId: null })));
  expect(generic.notify(end())).toContainEqual(
    expect.objectContaining({
      type: "chunk",
      chunk: expect.objectContaining({
        type: "tool-output-error",
        errorText: "The turn ended before the tool finished",
      }),
    }),
  );
  expect(generic.notify(delta("late"))).toEqual([]);
  const known = setup();
  known.notify(item("item/started", command()));
  known.notify(end());
  expect(known.mapper.flush()).toContainEqual({ type: "backgroundTasks", tasks: [] });
  expect(known.notify(delta("after exit"))).toEqual([]);
});

it("uses actual terminal interaction to identify a PTY, bounds incremental output and preserves a failed exit", () => {
  const { notify, acc } = setup();
  notify(item("item/started", command({ source: "agent", processId: null })));
  notify({
    method: "item/commandExecution/terminalInteraction",
    params: {
      threadId: "provider-parent",
      turnId: "parent-turn",
      itemId: "command-1",
      processId: "pty-1",
      stdin: "",
    },
  });
  notify(delta("x".repeat(70_000)));
  notify(end());
  const part = acc.snapshot().parts.find((p) => p.type === "dynamic-tool");
  expect(
    part?.state === "output-available" && (part.output as { stdout: string }).stdout.length,
  ).toBe(64_000);
  const failed = notify(
    item(
      "item/completed",
      command({ status: "failed", exitCode: 7, aggregatedOutput: "Synthetic process failed" }),
    ),
  );
  expect(failed).toContainEqual(
    expect.objectContaining({
      type: "chunk",
      chunk: expect.objectContaining({
        type: "tool-output-error",
        errorText: "Synthetic process failed",
      }),
    }),
  );
  expect(failed).toContainEqual({ type: "backgroundTasks", tasks: [] });
  expect(CODEX_CAPABILITIES).toMatchObject({ subagentStreams: false, stopTasks: false });
});

it("refreshes provisional command identity when its actual PTY start arrives without duplicating the tool", () => {
  const { notify } = setup();
  notify(item("item/started", command({ source: "agent", processId: null })));
  expect(notify(item("item/started", command()))).toEqual([]);
  expect(notify(end())).toContainEqual(
    expect.objectContaining({
      type: "backgroundTasks",
      tasks: [expect.objectContaining({ toolCallId: "command-1" })],
    }),
  );
});

it("retains observed output when the final command item provides no aggregate", () => {
  const { notify, acc } = setup();
  notify(item("item/started", command()));
  notify(delta("observed output"));
  notify(end());
  notify(item("item/completed", command({ status: "completed", exitCode: 0 })));
  expect(acc.snapshot().parts).toContainEqual(
    expect.objectContaining({
      state: "output-available",
      output: { stdout: "observed output", stderr: "", interrupted: false, exitCode: 0 },
    }),
  );
  expect(acc.preliminaryTools()).toEqual([]);
});

it.each([
  ["completed", "start first"],
  ["completed", "completion first"],
  ["failed", "start first"],
  ["failed", "completion first"],
  ["declined", "start first"],
  ["declined", "completion first"],
] as const)("does not resurrect a %s command on duplicate start (%s)", (status, order) => {
  const { notify, acc } = setup();
  if (order === "start first") notify(item("item/started", command()));
  notify(item("item/completed", command({ status, exitCode: status === "completed" ? 0 : 7 })));
  const completed = acc.snapshot();
  expect(notify(item("item/started", command()))).toEqual([]);
  expect(notify(delta("stale output"))).toEqual([]);
  expect(acc.snapshot()).toEqual(completed);
  expect(notify(end()).some((e) => e.type === "backgroundTasks" && e.tasks.length > 0)).toBe(false);
});

it.each([
  "repeated start",
  "interaction before parent end",
  "interaction after parent end",
] as const)("keeps the established process identity on a mismatched %s", (source) => {
  const { notify, acc } = setup();
  notify(item("item/started", command()));
  if (source === "interaction after parent end") notify(end());
  if (source === "repeated start") {
    expect(notify(item("item/started", command({ processId: "other-pty" })))).toEqual([]);
  } else {
    expect(
      notify({
        method: "item/commandExecution/terminalInteraction",
        params: {
          threadId: "provider-parent",
          turnId: "parent-turn",
          itemId: "command-1",
          processId: "other-pty",
          stdin: "invented input",
        },
      }),
    ).toEqual([]);
  }
  if (source !== "interaction after parent end") notify(end());
  expect(
    notify(item("item/completed", command({ status: "completed", exitCode: 0 }))),
  ).toContainEqual({ type: "backgroundTasks", tasks: [] });
  expect(acc.preliminaryTools()).toEqual([]);
});

it.each(["started", "interacted", "interrupted", "completed"] as const)(
  "surfaces an actual %s activity item without opening a child stream",
  (kind) => {
    const { notify } = setup();
    const events = notify(
      item("item/completed", {
        type: "subAgentActivity",
        id: "activity-1",
        kind,
        agentThreadId: "child-1",
        agentPath: "/parent/parser",
        model: "synthetic-model",
        reasoningEffort: "high",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "chunk",
        chunk: expect.objectContaining({
          type: "tool-output-available",
          output: {
            activity: kind,
            agentThreadId: "child-1",
            agentPath: "/parent/parser",
            model: "synthetic-model",
            reasoningEffort: "high",
          },
        }),
      }),
    );
    expect(events.some((e) => e.type === "subagentUsage" || e.type === "backgroundTasks")).toBe(
      false,
    );
  },
);

it.each([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
] as const)(
  "retains reported child %s as a snapshot, without promoting it to a live task",
  (status) => {
    const { notify } = setup();
    const events = notify(
      item("item/completed", {
        type: "collabAgentToolCall",
        id: "wait-1",
        tool: "wait",
        senderThreadId: "provider-parent",
        receiverThreadIds: ["child-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        status: "completed",
        agentsStates: { "child-1": { status, message: "Invented child report" } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "chunk",
        chunk: expect.objectContaining({
          type: "tool-output-available",
          output: {
            toolStatus: "completed",
            lastKnownAgentStates: { "child-1": { status, message: "Invented child report" } },
          },
        }),
      }),
    );
    expect(events.some((e) => e.type === "backgroundTasks" || e.type === "subagentUsage")).toBe(
      false,
    );
  },
);

it.each(["failed", "interrupted"] as const)(
  "settles a %s collaboration invocation separately from child state",
  (status) => {
    const { notify } = setup();
    const events = notify(
      item("item/completed", {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        senderThreadId: "provider-parent",
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        status,
        agentsStates: {},
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "chunk",
        chunk: expect.objectContaining({
          type: "tool-output-error",
          errorText: status === "interrupted" ? "Cancelled" : "Agent operation failed\n{}",
        }),
      }),
    );
  },
);

it("persists invocation completion and reported child state separately, with completion-only receiver metadata", () => {
  const acc = new MessageAccumulator("codex-collaboration");
  const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("codex-collaboration") });
  const collab: Item = {
    type: "collabAgentToolCall",
    id: "spawn-1",
    tool: "spawnAgent",
    senderThreadId: "provider-parent",
    receiverThreadIds: [],
    prompt: "Inspect the synthetic parser",
    model: "synthetic-model",
    reasoningEffort: "high",
    status: "inProgress",
    agentsStates: {},
  };
  const events = [
    ...mapper.map(item("item/started", collab, "collab-turn")),
    ...mapper.map(
      item(
        "item/completed",
        {
          ...collab,
          status: "completed",
          receiverThreadIds: ["child-1"],
          agentsStates: { "child-1": { status: "running", message: null } },
        },
        "collab-turn",
      ),
    ),
  ];
  for (const event of events) if (event.type === "chunk") acc.apply(event.chunk);
  expect(JSON.parse(JSON.stringify(acc.snapshot()))).toEqual(displayed.collaboration);
  expect(events.some((e) => e.type === "backgroundTasks" || e.type === "subagentUsage")).toBe(
    false,
  );
});

it.effect(
  "bounds retained replay after 128 KB of deltas, resumes from the same tail and retires the final lane",
  () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "Invented long-running output" },
      });
      const session = yield* waitFor(
        "send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const { mapper } = setup();
      const emit = (n: Notification) => session.emit(...mapper.map(n));
      yield* emit(item("item/started", command()));
      yield* emit(end());
      for (let i = 0; i < 1_000; i++) yield* emit(delta("x".repeat(128)));
      const marker = "last-output-marker";
      yield* emit(delta(marker));
      const tail = "x".repeat(64_000 - marker.length) + marker;
      const replay = yield* waitFor(
        "persisted latest tail and finish",
        runtimes.replay(thread.id).pipe(
          Effect.map((r) => {
            const last = r.inFlight.at(-1)?.event;
            return (
              last?.type === "chunk" &&
              last.chunk.type === "finish" &&
              r.inFlight.some(
                ({ event }) =>
                  event.type === "chunk" &&
                  event.chunk.type === "tool-output-available" &&
                  (event.chunk.output as { stdout?: string }).stdout === tail,
              ) &&
              r
            );
          }),
        ),
      );
      expect(JSON.stringify(replay.inFlight).length).toBeLessThan(100_000);
      expect(replay.inFlight).toHaveLength(displayed.retainedReplay.length);
      expect(replay.inFlight.map((i) => i.seq)).toEqual(
        [...new Set(replay.inFlight.map((i) => i.seq))].toSorted((a, b) => a - b),
      );
      expect(replay.lastSeq).toBeGreaterThanOrEqual(replay.inFlight.at(-1)!.seq);
      const expected = displayed.retainedReplay.map((c) => {
        if (c.type === "tool-output-available") {
          return { ...c, output: { stdout: tail, stderr: "", interrupted: false } };
        }
        // The turn is over and this reply is held: a reconnect learns how it ended from its finish.
        if (c.type !== "finish") return c;
        const turnEnd = { at: 0, reason: "completed" as const };
        return { ...c, messageMetadata: { ...c.messageMetadata, turnEnd } };
      });
      expect(
        replay.inFlight.map(({ event }) => {
          if (event.type !== "chunk") return event;
          if (event.chunk.type !== "start" && event.chunk.type !== "finish") return event.chunk;
          const { createdAt: _createdAt, ...metadata } = event.chunk.messageMetadata!;
          return { ...event.chunk, messageMetadata: metadata };
        }),
      ).toEqual(expected);
      const folded = new MessageAccumulator("codex-parent");
      for (const c of expected) folded.apply(c);
      const saved = yield* store.getMessage(thread.id, "codex-parent");
      expect(saved?.parts).toEqual(folded.snapshot().parts);
      expect(JSON.stringify(saved).length).toBeLessThan(100_000);
      const resumed = yield* runtimes.replay(thread.id, replay.rev);
      expect(resumed.resumed).toBe(true);
      expect(resumed.inFlight).toEqual(replay.inFlight);
      yield* emit(
        item(
          "item/completed",
          command({ status: "completed", aggregatedOutput: tail, exitCode: 0 }),
        ),
      );
      const final = yield* waitFor(
        "final persisted lane retirement",
        runtimes
          .replay(thread.id)
          .pipe(
            Effect.map((r) =>
              r.inFlight.length === 0 && r.messages.some((m) => m.id === "codex-parent")
                ? r
                : false,
            ),
          ),
      );
      expect(yield* runtimes.liveMessages(thread.id)).toEqual([]);
      expect(final.messages.filter((m) => m.id === "codex-parent")).toHaveLength(1);
      const finalResumed = yield* runtimes.replay(thread.id, replay.rev);
      expect(finalResumed.inFlight).toEqual([]);
      expect(finalResumed.messages.find((m) => m.id === "codex-parent")).toEqual(
        final.messages.find((m) => m.id === "codex-parent"),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
);

it.effect("keeps independent tool tails and finish metadata until the last process settles", () =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const fake = yield* FakeAgentControl;
    const store = yield* ThreadStore;
    const thread = yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text: "Invented independent commands" },
    });
    const session = yield* waitFor(
      "send",
      fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    const { mapper } = setup();
    const emit = (n: Notification) => session.emit(...mapper.map(n));
    yield* emit(item("item/started", command()));
    yield* emit(item("item/started", command({ id: "command-2", processId: "pty-2" })));
    yield* emit(end());
    yield* session.emit({
      type: "chunk",
      messageId: MessageId.make("codex-parent"),
      chunk: { type: "finish", messageMetadata: { agentMessageIds: ["extra-reported-id"] } },
    });
    yield* emit(delta("first tail"));
    yield* emit(delta("second tail", "parent-turn", "command-2"));
    const gap = mapper.map(delta(" between chunks"));
    yield* session.emit(gap[0]!);
    yield* waitFor(
      "output before its follow-up finish",
      runtimes.replay(thread.id).pipe(
        Effect.map((r) => {
          const latest = r.inFlight.at(-1)?.event;
          return latest?.type === "chunk" && latest.chunk.type === "tool-output-available";
        }),
      ),
    );
    const gapReplay = yield* runtimes.replay(thread.id);
    expect(
      gapReplay.inFlight.some(
        ({ event }) => event.type === "chunk" && event.chunk.type === "finish",
      ),
    ).toBe(false);
    const gapFold = new MessageAccumulator("codex-parent");
    for (const { event } of gapReplay.inFlight)
      if (event.type === "chunk") gapFold.apply(event.chunk);
    expect(gapFold.snapshot().metadata?.agentMessageIds).toEqual([
      "parent-turn",
      "extra-reported-id",
    ]);
    expect(gapFold.preliminaryTools()).toEqual(["command-1", "command-2"]);
    yield* session.emit(gap[1]!);
    const exit = mapper.map(item("item/completed", command({ status: "completed", exitCode: 0 })));
    yield* session.emit(exit[0]!);
    const exitGap = yield* waitFor(
      "exit output before its follow-up finish",
      runtimes.replay(thread.id).pipe(
        Effect.map((r) => {
          const latest = r.inFlight.at(-1)?.event;
          return (
            latest?.type === "chunk" &&
            latest.chunk.type === "tool-output-available" &&
            latest.chunk.preliminary !== true &&
            r
          );
        }),
      ),
    );
    expect(
      exitGap.inFlight.some(({ event }) => event.type === "chunk" && event.chunk.type === "finish"),
    ).toBe(false);
    const exitFold = new MessageAccumulator("codex-parent");
    for (const { event } of exitGap.inFlight)
      if (event.type === "chunk") exitFold.apply(event.chunk);
    expect(exitFold.preliminaryTools()).toEqual(["command-2"]);
    expect(exitFold.snapshot().parts.filter((p) => p.type === "dynamic-tool")).toHaveLength(2);
    yield* session.emit(...exit.slice(1));
    const retained = yield* waitFor(
      "only second process remains",
      runtimes.snapshot.pipe(
        Effect.map(
          (s) => s[0]?.background?.[0]?.toolCallId === "command-2" && s[0].background.length === 1,
        ),
      ),
    );
    expect(retained).toBe(true);
    const replay = yield* runtimes.replay(thread.id);
    const folded = new MessageAccumulator("codex-parent");
    for (const { event } of replay.inFlight) if (event.type === "chunk") folded.apply(event.chunk);
    expect(folded.snapshot().metadata?.agentMessageIds).toEqual([
      "parent-turn",
      "extra-reported-id",
    ]);
    expect(folded.preliminaryTools()).toEqual(["command-2"]);
    expect(
      replay.inFlight.filter(
        ({ event }) => event.type === "chunk" && event.chunk.type === "finish",
      ),
    ).toHaveLength(1);
    expect(folded.snapshot().parts).toEqual(
      (yield* store.getMessage(thread.id, "codex-parent"))?.parts,
    );
    yield* session.end();
    yield* waitFor(
      "termination retires the last preliminary lane",
      runtimes.replay(thread.id).pipe(Effect.map((r) => r.inFlight.length === 0)),
    );
    expect(yield* runtimes.liveMessages(thread.id)).toEqual([]);
    const saved = yield* store.getMessage(thread.id, "codex-parent");
    expect(saved?.parts).toContainEqual(
      expect.objectContaining({ toolCallId: "command-2", state: "output-error" }),
    );
  }).pipe(Effect.provide(RuntimeTestLayer)),
);

it.effect(
  "projects actual mapper events through persistence, idle retention, another turn, late exit and session cleanup",
  () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "Run a synthetic background command" },
      });
      const session = yield* waitFor(
        "first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const { mapper } = setup();
      const emit = (n: Notification) => session.emit(...mapper.map(n));
      yield* emit(item("item/started", command()));
      yield* emit(delta("ready\n"));
      yield* emit(idle);
      yield* emit(end());
      yield* waitFor(
        "idle background command",
        runtimes.snapshot.pipe(
          Effect.map((s) => s[0]?.background?.length === 1 && s[0]?.status === "idle"),
        ),
      );
      expect((yield* store.getMessage(thread.id, "codex-parent"))?.parts).toEqual(
        displayed.background.parts,
      );
      expect(yield* runtimes.working).toEqual([thread.id]);
      yield* TestClock.adjust("16 minutes");
      expect(session.closed).toBe(false);
      yield* runtimes.send(thread.id, { text: "A second turn" });
      yield* waitFor(
        "second send",
        Effect.sync(() => session.sent.length === 2),
      );
      yield* emit({
        method: "turn/started",
        params: { threadId: "provider-parent", turn: turn("second-turn", "inProgress") },
      });
      yield* emit(delta("done\n"));
      expect(yield* runtimes.status(thread.id)).toBe("running");
      yield* emit(
        item(
          "item/completed",
          command({ status: "completed", aggregatedOutput: "ready\ndone\n", exitCode: 0 }),
        ),
      );
      yield* waitFor(
        "stored original exit",
        store
          .getMessage(thread.id, "codex-parent")
          .pipe(
            Effect.map((m) =>
              m?.parts.some(
                (p) =>
                  p.type === "dynamic-tool" &&
                  p.state === "output-available" &&
                  p.preliminary !== true,
              ),
            ),
          ),
      );
      expect((yield* store.getMessage(thread.id, "codex-parent"))?.parts).toEqual(
        displayed.completed.parts,
      );
      expect(
        (yield* store.listMessages(thread.id)).filter((m) =>
          m.parts.some((p) => p.type === "dynamic-tool" && p.toolCallId === "command-1"),
        ),
      ).toHaveLength(1);
      yield* emit(
        item("item/started", command({ id: "command-2", processId: "pty-2" }), "second-turn"),
      );
      yield* emit(idle);
      yield* emit({
        method: "turn/completed",
        params: { threadId: "provider-parent", turn: turn("second-turn") },
      });
      yield* waitFor(
        "second background",
        runtimes.snapshot.pipe(
          Effect.map((s) => s[0]?.background?.length === 1 && s[0]?.status === "idle"),
        ),
      );
      // Scope termination without mapper flush must still settle saved preliminary cards.
      yield* session.end();
      yield* waitFor(
        "scope cleanup",
        runtimes.snapshot.pipe(Effect.map((s) => (s[0]?.background?.length ?? 0) === 0)),
      );
      yield* waitFor(
        "saved scope error",
        store
          .listMessages(thread.id)
          .pipe(
            Effect.map((messages) =>
              messages.some((m) =>
                m.parts.some(
                  (p) =>
                    p.type === "dynamic-tool" &&
                    p.toolCallId === "command-2" &&
                    p.state === "output-error" &&
                    p.errorText === "Session ended before the process exited",
                ),
              ),
            ),
          ),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
);
