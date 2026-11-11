// Moving a plain thread or worker to the other agent (`switchAgent`), with the synthetic agent.
import { describe, expect, it } from "@effect/vitest";
import type { HostId, ModelRef, ProfileId, RequestId, ThreadId } from "@gram/contracts";
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
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
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

/** The thread once its switch is over: released, idle, on the target's session. */
const switched = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      "the switch to finish",
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const status = yield* runtimes.status(threadId);
        return thread.sessionSwitch === undefined && status === "idle" && thread;
      }),
    );
  });

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
      yield* runtimes.switchAgent(thread.id, CODEX);
      yield* waitFor(
        "the old session stopping",
        store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch?.phase === "stopping")),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      yield* fake.setSwitchStopDelay(undefined);
      yield* TestClock.adjust("300 millis");
      yield* waitFor(
        "the message on the new session",
        fake
          .latest(thread.id)
          .pipe(Effect.map((s) => s !== session && s.sent.some((input) => input.text === "two"))),
      );
      expect(session.sent.map((input) => input.text)).toEqual(["one"]);
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

      yield* runtimes.switchAgent(thread.id, CODEX);
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
      yield* runtimes.switchAgent(thread.id, CODEX);
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
      yield* runtimes.switchAgent(thread.id, CODEX);
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

  it.effect("goes back to the source session when the target fails to start cleanly", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* idleThread;
      yield* fake.setUnavailable("synthetic target refused to start");
      yield* runtimes.switchAgent(thread.id, CODEX);
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
