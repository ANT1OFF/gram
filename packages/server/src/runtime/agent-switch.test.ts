// Moving a plain thread or worker to the other agent (`switchAgent`), with the synthetic agent.
import { describe, expect, it } from "@effect/vitest";
import type {
  AgentEvent,
  HostId,
  MessageId,
  ModelRef,
  ProfileId,
  RequestId,
  ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { LIMIT_RESUME_TEXT } from "./limit-wait.ts";
import { notePrompt } from "./switch-handoff.ts";
import { RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

/** The runtime over a database file, so a second layer is the app after a restart. */
const layerAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

const CODEX: ModelRef = { agent: "codex", model: "fake-opus" };

/** A Claude thread whose first turn has ended, idle on its live session. */
const idleThread = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  yield* session.completeTurn("done");
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  return { thread: yield* (yield* ThreadStore).getThread(thread.id), session };
});

/** The synthetic note the old session replies with, and the new session's reply to its handoff. */
const NOTE = "Goal: ship the cart. Done: the model. Next: the view. Trap: the fixture clock.";
const READY = "Ready.";

/** A synthetic GitHub token, put together here so no file holds one whole. */
const SYNTHETIC_TOKEN = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");

const isNotePrompt = (text: string) => text.startsWith("Your session ends after this turn");
const isHandoff = (text: string) => text.includes("\n<gram-handoff ");

/** How many of each session's inputs have been answered by `answerSwitchTurns`. */
const answered = new WeakMap<FakeSession, number>();

/**
 * Answers the switch's own turns on the thread's latest session, once each: the old session's note
 * turn with `note`, the new session's handoff with `reply`.
 */
const answerSwitchTurns = (threadId: ThreadId, note = NOTE, reply = READY) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    const session = yield* fake.latest(threadId);
    const last = session.sent.length - 1;
    const input = session.sent[last];
    if (input === undefined || (answered.get(session) ?? -1) >= last) return;
    if (!isNotePrompt(input.text) && !isHandoff(input.text)) return;
    answered.set(session, last);
    yield* session.completeTurn(isNotePrompt(input.text) ? note : reply);
  });

/** The thread once its switch is over: released, idle, on the target's session. */
const switched = (threadId: ThreadId, note?: string, reply?: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      "the switch to finish",
      Effect.gen(function* () {
        yield* answerSwitchTurns(threadId, note, reply);
        const thread = yield* store.getThread(threadId);
        const status = yield* runtimes.status(threadId);
        return thread.sessionSwitch === undefined && status === "idle" && thread;
      }),
    );
  });

/** The handoff the thread's latest session was given. */
const handoffSent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    const text = (yield* fake.latest(threadId)).sent.find((input) => isHandoff(input.text))?.text;
    expect(text).toBeDefined();
    return text!;
  });

/** The recent-turns section of a handoff. */
const recentTurnsOf = (handoff: string) => handoff.slice(handoff.indexOf("## Recent turns"));

const handoffParts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.messagesWithParts(threadId, ["data-handoff"])).flatMap((m) =>
      m.parts.flatMap((part) => (part.type === "data-handoff" ? [part.data] : [])),
    );
  });

/** What a refused switch must have left alone. */
const unchanged = (threadId: ThreadId, before: { model: ModelRef; agentSessionId?: string }) =>
  Effect.gen(function* () {
    const after = yield* (yield* ThreadStore).getThread(threadId);
    expect(after.model).toEqual(before.model);
    expect(after.agentSessionId).toBe(before.agentSessionId);
    expect(after.sessionSwitch).toBeUndefined();
    expect(yield* handoffParts(threadId)).toEqual([]);
  });

describe("switchAgent", () => {
  it.effect("moves an idle thread to the other agent in a fresh session, with a divider", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      expect(thread.model.agent).toBe("claude");
      const previousId = thread.agentSessionId;
      expect(previousId).toBeDefined();

      const claimed = yield* runtimes.switchAgent(thread.id, CODEX);
      expect(claimed.sessionSwitch).toMatchObject({ target: CODEX, previous: thread.model });

      const after = yield* switched(thread.id);
      expect(after.model).toEqual(CODEX);
      expect(after.agentSessionId).not.toBe(previousId);
      expect(after.codexHome === undefined || after.codexHome !== thread.codexHome).toBe(true);
      expect(session.closed).toBe(true);
      const next = yield* fake.latest(thread.id);
      expect(next).not.toBe(session);
      expect(next.options.model).toEqual(CODEX);
      // Nothing of the old conversation is resumed.
      expect(next.options.resumeId).toBeUndefined();
      expect(next.options.fork).toBeUndefined();
      expect(yield* handoffParts(thread.id)).toEqual([
        expect.objectContaining({
          reason: "switch",
          previousAgent: "claude",
          previousAgentSessionId: previousId,
          switchId: claimed.sessionSwitch!.id,
        }),
      ]);

      // And back: another fresh session, another divider.
      yield* runtimes.switchAgent(thread.id, thread.model);
      const back = yield* switched(thread.id);
      expect(back.model).toEqual(thread.model);
      expect((yield* fake.latest(thread.id)).options.resumeId).toBeUndefined();
      expect((yield* handoffParts(thread.id)).map((h) => h.previousAgent)).toEqual([
        "claude",
        "codex",
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("holds a message sent during the switch for the new session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const store = yield* ThreadStore;
      const { thread, session } = yield* idleThread;
      yield* fake.setSwitchStopDelay("200 millis");
      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      yield* waitFor(
        "the old session stopping",
        store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch?.phase === "stopping")),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      yield* fake.setSwitchStopDelay(undefined);
      yield* TestClock.adjust("300 millis");
      const next = yield* waitFor(
        "the message on the new session",
        answerSwitchTurns(thread.id).pipe(
          Effect.andThen(fake.latest(thread.id)),
          Effect.map((s) => s !== session && s.sent.some((input) => input.text === "two") && s),
        ),
      );
      expect(session.sent.map((input) => input.text)).toEqual(["one"]);
      // After the handoff's turn, never before it or into it.
      expect(next.sent.map((input) => isHandoff(input.text) || input.text)).toEqual([true, "two"]);
      expect(next.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("switches a cold thread, which has no process to stop", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread } = yield* idleThread;
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* waitFor("cold", runtimes.status(thread.id).pipe(Effect.map((s) => s === "cold")));
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
      const opened = fake.sessions.length;

      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      const after = yield* switched(thread.id);
      expect(after.model).toEqual(CODEX);
      expect(fake.sessions.length).toBe(opened + 1);
      expect((yield* fake.latest(thread.id)).options.resumeId).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses mid-turn, with an approval open, and on the same agent", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const before = yield* (yield* ThreadStore).getThread(thread.id);
      const refused = (target: ModelRef) =>
        runtimes.switchAgent(thread.id, target).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );

      expect(yield* refused(CODEX)).toBe("Wait for this turn to finish, or stop it, then switch.");

      yield* session.emit({
        type: "request",
        request: {
          kind: "approval",
          id: "r1" as RequestId,
          toolName: "Bash",
          displayName: "Bash",
          input: {},
          suggestions: [],
        },
      });
      yield* waitFor(
        "the approval",
        (yield* ThreadStore).listRequests(thread.id).pipe(Effect.map((r) => r.length === 1)),
      );
      yield* session.completeTurn();
      yield* waitFor(
        "the turn's end",
        runtimes.status(thread.id).pipe(Effect.map((s) => s !== "running")),
      );
      const withApproval = yield* refused(CODEX);
      expect([
        "Answer the open approval first. It can't move to Codex.",
        "Wait for this turn to finish, or stop it, then switch.",
      ]).toContain(withApproval);

      expect(yield* refused({ ...before.model, model: "fake-haiku" })).toBe(
        "This thread already runs in Claude Code. Pick one of its models instead.",
      );
      yield* unchanged(thread.id, before);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "refuses above High, a gateway profile, a joined machine, an unused fork and an orchestrator",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { thread } = yield* idleThread;
        const refused = (target: ModelRef) =>
          runtimes.switchAgent(thread.id, target).pipe(
            Effect.flip,
            Effect.map((e) => e.message),
          );
        const set = (f: Parameters<typeof store.updateThread>[1]) =>
          store.updateThread(thread.id, f);

        expect(yield* refused({ ...CODEX, variant: "xhigh" })).toBe(
          "A switch runs at High effort at most. Pick High or lower.",
        );
        expect(yield* refused({ ...CODEX, profileId: "litellm" as ProfileId })).toContain(
          "Switching does not migrate gateway credentials",
        );

        yield* set((t) => ({ ...t, model: { ...t.model, profileId: "litellm" as ProfileId } }));
        expect(yield* refused(CODEX)).toBe(
          "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.",
        );
        yield* set((t) => {
          const { profileId: _p, ...model } = t.model;
          return { ...t, model };
        });

        yield* set((t) => ({ ...t, checkout: { ...t.checkout, hostId: "box" as HostId } }));
        expect(yield* refused(CODEX)).toBe("Codex can't run on this thread's machine yet.");
        yield* set((t) => ({ ...t, checkout: thread.checkout }));

        yield* set((t) => ({
          ...t,
          forkedFrom: { agentSessionId: "source" },
          agentSessionUnused: true,
        }));
        expect(yield* refused(CODEX)).toBe("Send once in this fork first.");
        yield* set(({ forkedFrom: _f, agentSessionUnused: _u, ...t }) => t);

        yield* set((t) => ({ ...t, role: "orchestrator" }));
        expect(yield* refused(CODEX)).toBe(
          "Switch the orchestrator from its own Switch orchestrator… action.",
        );
        yield* set(({ role: _r, ...t }) => t);

        yield* unchanged(thread.id, thread);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses a target signed out, unlisted, or on a build that can't switch", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      const refused = (target: ModelRef) =>
        runtimes.switchAgent(thread.id, target).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );

      expect(yield* refused({ ...CODEX, model: "not-listed" })).toContain(
        "does not list not-listed",
      );
      yield* fake.setModelDiscoveryFailure("Codex isn't signed in.");
      expect(yield* refused(CODEX)).toContain("Codex isn't signed in.");
      yield* fake.setModelDiscoveryFailure(undefined);
      yield* fake.setSwitchCapability(false);
      expect(yield* refused(CODEX)).toContain("unavailable on this platform");
      yield* fake.setSwitchCapability(true);

      yield* unchanged(thread.id, thread);
      expect(session.closed).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a used fork's source thread but no longer forks its session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread } = yield* idleThread;
      const source = "source-thread" as ThreadId;
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        forkedFrom: { threadId: source, agentSessionId: "source-session" },
      }));
      yield* runtimes.switchAgent(thread.id, CODEX);
      const after = yield* switched(thread.id);
      expect(after.forkedFrom).toEqual({ threadId: source });
      const next = yield* fake.latest(thread.id);
      expect(next.options.resumeId).toBeUndefined();
      expect(next.options.fork).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the thread's bindings: its PR, wakes and plan stay where they were", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* idleThread;
      const boundPr = {
        repo: "acme/shop",
        number: 7,
        monitor: true,
        reviewMonitor: true,
        mergeWhenReady: { method: "squash" as const, allowedBy: "user" as const, setAt: 1 },
      };
      yield* store.updateThread(thread.id, (t) => ({ ...t, boundPr }) as typeof t);
      const bound = yield* store.getThread(thread.id);
      yield* runtimes.switchAgent(thread.id, CODEX);
      const after = yield* switched(thread.id);
      expect(after.boundPr).toEqual(bound.boundPr);
      expect(after.title).toBe(bound.title);
      expect(after.checkout).toEqual(bound.checkout);
      expect(after.mode).toBe(bound.mode);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fails a switch whose old session won't stop, holds the queue, and retries", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread } = yield* idleThread;
      yield* fake.setSwitchStopFailure("synthetic stop failure");
      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      const failed = yield* waitFor(
        "the failed switch",
        store
          .getThread(thread.id)
          .pipe(Effect.map((t) => t.sessionSwitch?.phase === "failed" && t.sessionSwitch)),
      );
      expect(failed.detail).toContain("synthetic stop failure");
      yield* fake.setSwitchStopFailure(undefined);
      yield* runtimes.switchAgent(thread.id, CODEX);
      const after = yield* switched(thread.id);
      expect(after.model).toEqual(CODEX);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("settles at boot the switches a restart cut off, each by how far it got", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-switch-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const ids = yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const made = [];
        for (const phase of ["checkpoint", "stopping", "ready"] as const) {
          const { thread } = yield* idleThread;
          yield* store.updateThread(thread.id, (t) => ({
            ...t,
            ...(phase === "ready" ? { model: CODEX } : {}),
            sessionSwitch: {
              id: `attempt-${phase}`,
              previous: thread.model,
              target: CODEX,
              mode: thread.mode,
              phase,
              oldExited: phase === "ready",
            },
          }));
          made.push(thread.id);
        }
        return made;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const [checkpoint, stopping, ready] = yield* Effect.forEach(ids, (id) =>
          store.getThread(id),
        );
        // Nothing had happened to its session: dropped, still on Claude.
        expect(checkpoint!.sessionSwitch).toBeUndefined();
        expect(checkpoint!.model.agent).toBe("claude");
        expect(yield* handoffParts(checkpoint!.id)).toEqual([]);
        // Caught between: failed, so nothing starts on its own and the queue stays held.
        expect(stopping!.sessionSwitch).toMatchObject({ phase: "failed" });
        expect(stopping!.sessionSwitch!.detail).toContain("The app restarted during this switch.");
        // Its new session was confirmed: finished with its divider, once.
        expect(ready!.sessionSwitch).toBeUndefined();
        expect(ready!.model).toEqual(CODEX);
        expect(yield* handoffParts(ready!.id)).toEqual([
          expect.objectContaining({
            reason: "switch",
            previousAgent: "claude",
            switchId: "attempt-ready",
          }),
        ]);
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("rolls back when an approval arrives while the old session stops", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      yield* fake.setSwitchStopDelay("200 millis");
      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      yield* waitFor(
        "the old session stopping",
        store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch?.phase === "stopping")),
      );
      yield* session.emit({
        type: "request",
        request: {
          kind: "approval",
          id: "late" as RequestId,
          toolName: "Bash",
          displayName: "Bash",
          input: {},
          suggestions: [],
        },
      });
      yield* waitFor(
        "the late approval stored",
        store.listRequests(thread.id).pipe(Effect.map((r) => r.length === 1)),
      );
      yield* fake.setSwitchStopDelay(undefined);
      yield* TestClock.adjust("300 millis");
      const after = yield* waitFor(
        "the switch rolled back",
        store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch === undefined && t)),
      );
      // Never half-switched: the source model and session, no target session, no divider.
      expect(after.model).toEqual(thread.model);
      expect(after.agentSessionId).toBe(thread.agentSessionId);
      expect(fake.sessions.some((s) => s.options.model?.agent === "codex")).toBe(false);
      expect(yield* handoffParts(thread.id)).toEqual([]);
      // The next send resumes the session it had, which can ask again.
      yield* runtimes.send(thread.id, { text: "carry on" });
      const resumed = yield* waitFor(
        "the source resumed",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
      );
      expect(resumed.options.resumeId).toBe(thread.agentSessionId);
      expect(resumed.options.model).toEqual(thread.model);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  // Neither a turn the agent opens itself nor a nested subagent's start is a request or a
  // background task, and the stop's teardown clears both before the switch looks again.
  const lateStarts: ReadonlyArray<readonly [string, ReadonlyArray<AgentEvent>]> = [
    [
      "a turn of its own",
      [
        {
          type: "chunk",
          messageId: "late-agent-turn" as MessageId,
          chunk: {
            type: "start",
            messageId: "late-agent-turn",
            messageMetadata: { initiator: "agent" },
          },
        },
      ],
    ],
    [
      "a nested subagent",
      [
        {
          type: "chunk",
          messageId: "late-subagent" as MessageId,
          chunk: {
            type: "start",
            messageId: "late-subagent",
            messageMetadata: { parentToolUseId: "source-background-agent" },
          },
        },
        {
          type: "chunk",
          messageId: "late-subagent" as MessageId,
          chunk: { type: "reasoning-start", id: "thinking" },
        },
      ],
    ],
  ];
  for (const [what, events] of lateStarts) {
    it.effect(`rolls back when the old session starts ${what} while it stops`, () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const { thread, session } = yield* idleThread;
        yield* fake.setSwitchStopDelay("200 millis");
        yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
        yield* waitFor(
          "the old session stopping",
          store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch?.phase === "stopping")),
        );
        yield* session.emit(...events);
        yield* waitFor(
          "the runtime to show it",
          runtimes.snapshot.pipe(
            Effect.map((all) =>
              all.some(
                (t) =>
                  t.thread.id === thread.id && (t.status === "running" || t.activity !== undefined),
              ),
            ),
          ),
        );
        yield* fake.setSwitchStopDelay(undefined);
        yield* TestClock.adjust("300 millis");
        const after = yield* waitFor(
          "the switch settled",
          store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch === undefined && t)),
        );
        expect(after.model).toEqual(thread.model);
        expect(after.agentSessionId).toBe(thread.agentSessionId);
        expect(fake.sessions.some((s) => s.options.model?.agent === "codex")).toBe(false);
        expect(yield* handoffParts(thread.id)).toEqual([]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect("goes back to the source session when the target fails to start cleanly", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      yield* fake.setUnavailable("synthetic target refused to start");
      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      const after = yield* waitFor(
        "the switch rolled back",
        store
          .getThread(thread.id)
          .pipe(Effect.map((t) => t.sessionSwitch === undefined && session.closed && t)),
      );
      expect(after.model).toEqual(thread.model);
      expect(after.agentSessionId).toBe(thread.agentSessionId);
      expect(after.codexHome).toEqual(thread.codexHome);
      expect(yield* handoffParts(thread.id)).toEqual([]);
      yield* fake.setUnavailable(undefined);
      // Usable on its old agent: a send goes out, it isn't held.
      const sent = yield* runtimes.send(thread.id, { text: "two" });
      expect(sent).not.toMatchObject({ queued: true });
      const resumed = yield* waitFor(
        "the source resumed",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
      );
      expect(resumed.options.resumeId).toBe(thread.agentSessionId);
      expect(resumed.sent.map((i) => i.text)).toEqual(["two"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("switchAgent's handoff", () => {
  it.effect("asks the old session for a note, holds the queue, and hands it over capped", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;

      yield* runtimes.switchAgent(thread.id, CODEX);
      yield* waitFor(
        "the note turn",
        Effect.sync(() => session.sent.length === 2),
      );
      // The plan's wording, naming where the thread goes.
      expect(session.sent[1]!.text).toBe(notePrompt("codex"));
      expect(session.sent[1]!.text).toContain("continues in Codex");
      // Input sent while the old session writes its note waits for the new one.
      expect(yield* runtimes.send(thread.id, { text: "two" })).toMatchObject({ queued: true });
      yield* session.completeTurn(
        `Goal: ship it. Key ${SYNTHETIC_TOKEN} is in the env. ${"x".repeat(5000)}`,
      );

      const next = yield* waitFor(
        "the handoff on the new session",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
      );
      const handoff = next.sent[0]!.text;
      expect(
        handoff.startsWith("This thread was started in Claude Code and continues here in Codex."),
      ).toBe(true);
      expect(handoff).toContain("## Handoff note from Claude Code");
      expect(handoff).toContain("Goal: ship it.");
      expect(handoff).toContain("[redacted]");
      expect(handoff).not.toContain("ghp_");
      expect(handoff).toContain("[note cut at 4,000 characters]");
      expect(handoff).toContain("- Path: /work/repo");
      // The note turn is the switch's own: its prompt is not replayed as a turn.
      expect(recentTurnsOf(handoff)).not.toContain("Your session ends after this turn");
      expect(recentTurnsOf(handoff)).toContain("one");
      // Nothing else reaches the new session until its handoff turn ends.
      expect(session.sent.map((input) => input.text)).toEqual(["one", notePrompt("codex")]);
      yield* next.completeTurn(READY);
      yield* waitFor(
        "the held message",
        Effect.sync(() => next.sent.some((input) => input.text === "two")),
      );
      expect(next.steered).toEqual([]);

      const [part] = yield* handoffParts(thread.id);
      expect(part).toMatchObject({
        reason: "switch",
        previousAgent: "claude",
        noteMode: "outgoing",
      });
      expect(part!.note!.by).toBe("claude");
      expect(part!.note!.text.length).toBeLessThanOrEqual(4000);
      expect(part!.note!.text).not.toContain("ghp_");
      expect(part!.facts).toContain("- Path: /work/repo");
      expect((yield* store.getThread(thread.id)).model).toEqual(CODEX);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("stays where it was when the note turn ends early for another reason", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      yield* runtimes.switchAgent(thread.id, CODEX);
      yield* waitFor(
        "the note turn",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(yield* runtimes.send(thread.id, { text: "two" })).toMatchObject({ queued: true });
      yield* session.emit({ type: "turnEnd", reason: "interrupted" });
      const after = yield* waitFor(
        "the switch called off",
        store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch === undefined && t)),
      );
      expect(after.model).toEqual(thread.model);
      expect(after.agentSessionId).toBe(thread.agentSessionId);
      expect(yield* handoffParts(thread.id)).toEqual([]);
      expect(fake.sessions.some((s) => s.options.model?.agent === "codex")).toBe(false);
      // What it held goes to the session it kept.
      yield* waitFor(
        "the held message on the old session",
        Effect.sync(() => session.sent.some((input) => input.text === "two")),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("sends facts and recent turns only when the user leaves the note out", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* idleThread;
      yield* runtimes.switchAgent(thread.id, CODEX, { note: false });
      yield* switched(thread.id);
      expect(session.sent.map((input) => input.text)).toEqual(["one"]);
      const handoff = yield* handoffSent(thread.id);
      expect(handoff).toContain("## Handoff note\n\nNone: the user switched without one.");
      expect(handoff).toContain("## Facts from Gram");
      expect(recentTurnsOf(handoff)).toContain("done");
      expect(handoff).toContain("Reply with one line saying you have this context");
      const [part] = yield* handoffParts(thread.id);
      expect(part).toMatchObject({ noteMode: "none" });
      expect(part!.note).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "in limit mode the new agent writes the note in its first turn, the queue held till it ends",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        const session = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        // The agent's own usage-limit report ends the turn: the thread waits out the limit.
        yield* session.emit({
          type: "turnEnd",
          reason: "error",
          error: "You've hit your session limit · resets 12:50pm (Europe/Oslo)",
          failure: { kind: "rateLimit", httpStatus: 429, code: "rate_limit", retryable: true },
        });
        yield* waitFor(
          "the limit wait",
          store.getThread(thread.id).pipe(Effect.map((t) => t.limitWait !== undefined)),
        );

        // A new session that can take input mid-turn, which a notice would otherwise be steered into.
        yield* fake.setSteerCapability(true);
        yield* runtimes.switchAgent(thread.id, CODEX);
        const next = yield* waitFor(
          "the catch-up on the new session",
          fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
        );
        // No note turn on the old session: it can't take one.
        expect(session.sent.map((input) => input.text)).toEqual(["one"]);
        const handoff = next.sent[0]!.text;
        expect(handoff).toContain("None: Claude Code couldn't write one, so you write it");
        expect(handoff).toContain("Claude Code couldn't write a handoff note: it is out of usage");
        expect(handoff).toContain("Before any work, write that note yourself");
        // The old account's wait is over: nothing resumes the old turn on the new agent.
        expect((yield* store.getThread(thread.id)).limitWait).toBeUndefined();

        // Queued while the catch-up runs: held, never steered into it, Gram's own notices included,
        // which a running turn would otherwise take mid-turn.
        expect(
          yield* runtimes.sendNotice(thread.id, "pr-monitor", { text: "CI passed on #7." }),
        ).toMatchObject({ queued: true, steered: false });
        expect(yield* runtimes.send(thread.id, { text: "two" })).toMatchObject({ queued: true });
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        expect(next.sent.map((input) => input.text)).toEqual([handoff]);
        expect(next.steered).toEqual([]);
        yield* next.completeTurn("Goal: one. Done: nothing yet. Next: retry one.");
        // Then what was held, in order, each a turn of its own after the catch-up.
        yield* waitFor(
          "the held notice after the catch-up",
          Effect.sync(() => next.sent.some((input) => input.text === "CI passed on #7.")),
        );
        expect(next.steered).toEqual([]);
        yield* next.completeTurn("noted");
        yield* waitFor(
          "the held message after the catch-up",
          Effect.sync(() => next.sent.some((input) => input.text === "two")),
        );
        expect(next.sent.some((input) => input.text === LIMIT_RESUME_TEXT)).toBe(false);

        const parts = yield* waitFor(
          "the note on the divider",
          handoffParts(thread.id).pipe(Effect.map((p) => p[0]?.note !== undefined && p)),
        );
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({
          noteMode: "limit",
          note: { by: "codex", text: "Goal: one. Done: nothing yet. Next: retry one." },
        });
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("takes a thread whose last turn failed in limit mode too", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* idleThread;
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        lastError: { kind: "unknown", retryable: false, text: "The agent stopped.", at: 1 },
      }));
      yield* runtimes.switchAgent(thread.id, CODEX);
      yield* switched(thread.id);
      expect(session.sent.map((input) => input.text)).toEqual(["one"]);
      expect(yield* handoffSent(thread.id)).toContain(
        "couldn't write a handoff note: its last turn failed (The agent stopped.)",
      );
      expect((yield* handoffParts(thread.id))[0]).toMatchObject({ noteMode: "limit" });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("switching back replays only the turns since the divider, with the earlier note", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread } = yield* idleThread;
      yield* runtimes.switchAgent(thread.id, CODEX);
      yield* switched(thread.id, "NOTE FROM CLAUDE");

      yield* runtimes.send(thread.id, { text: "a codex step" });
      const codex = yield* fake.latest(thread.id);
      yield* waitFor(
        "the codex step",
        Effect.sync(() => codex.sent.some((input) => input.text === "a codex step")),
      );
      yield* codex.completeTurn("codex did the step");
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      yield* runtimes.switchAgent(thread.id, thread.model);
      yield* switched(thread.id, "NOTE FROM CODEX");
      const handoff = yield* handoffSent(thread.id);
      expect(
        handoff.startsWith("This thread was started in Codex and continues here in Claude Code."),
      ).toBe(true);
      expect(handoff).toContain("## Handoff note from Codex\n\nNOTE FROM CODEX");
      expect(handoff).toContain(
        "## Earlier handoff note, from Claude Code at the previous switch\n\nNOTE FROM CLAUDE",
      );
      const turns = recentTurnsOf(handoff);
      expect(turns).toContain("a codex step");
      expect(turns).toContain("codex did the step");
      expect(turns).toContain("since its previous switch");
      // Not before the divider, and not the first handoff's exchange.
      expect(turns).not.toContain("\ndone\n");
      expect(turns).not.toContain("This thread was started in");
      expect(turns).not.toContain(READY);
      expect((yield* handoffParts(thread.id)).map((h) => h.previousAgent)).toEqual([
        "claude",
        "codex",
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
