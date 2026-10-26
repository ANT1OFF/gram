import { describe, expect, it } from "@effect/vitest";
import { fenceThreadMessage, initialBabysitState, ProfileId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { makeRuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  archiveHold,
  joinMessages,
  OrchestrationAppToolsLive,
  originOf,
} from "./orchestration-tools.ts";
import { AppToolRegistry } from "./registry.ts";

const TestLayer = OrchestrationAppToolsLive.pipe(Layer.provideMerge(makeRuntimeTestLayer()));

const statusIs = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor(status, runtimes.status(threadId).pipe(Effect.map((s) => s === status)));
  });

const createThread = (title: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: `/work/${title}`,
      checkout: { kind: "main", path: `/work/${title}` },
      title,
    });
    yield* statusIs(thread.id, "idle");
    return thread;
  });

/** A tool as the in-process host binds it, or with `gated` through the registry's own card gate. */
const tool = (caller: ThreadId, name: string, gated = false) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tools = gated ? registry.forTransport(caller) : registry.forThread(caller);
    const found = tools.find((t) => t.descriptor.name === name);
    if (found === undefined) return yield* Effect.die(new Error(`no app tool ${name}`));
    return found;
  });

const run = (caller: ThreadId, name: string, input: unknown) =>
  tool(caller, name).pipe(Effect.flatMap((t) => t.run(input)));

const refusal = (caller: ThreadId, name: string, input: unknown) =>
  run(caller, name, input).pipe(
    Effect.flip,
    Effect.map((e) => e.message),
  );

const sessionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const control = yield* FakeAgentControl;
    return yield* waitFor(
      "a session",
      Effect.sync(() => control.sessions.findLast((s) => s.options.threadId === threadId)),
    );
  });

const userMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const messages = yield* (yield* ThreadStore).listMessages(threadId);
    return messages.filter((m) => m.role === "user");
  });

/** A PR badge as `archiveHold` reads it. */
const badge = (repo: string, number: number, state: "OPEN" | "MERGED" | "CLOSED") => ({
  number,
  state,
  url: `https://github.com/${repo}/pull/${number}`,
});

describe("orchestration app tools", () => {
  it.effect("send_message delivers with its origin and refuses self and back-to-back sends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const planner = yield* createThread("Planner");
      const worker = yield* createThread("Worker");

      expect(
        yield* run(planner.id, "send_message", { threadId: worker.id, text: "Please add tests." }),
      ).toEqual({ threadId: worker.id, title: "Worker", delivered: "sent" });
      const origin = { threadId: planner.id, title: "Planner", depth: 1 };
      // The agent reads another thread's message fenced as that thread's; the transcript as written.
      expect((yield* sessionOf(worker.id)).sent[0]).toEqual({
        text: fenceThreadMessage(origin, "Please add tests."),
        origin,
      });
      const [delivered] = yield* userMessages(worker.id);
      expect(delivered === undefined ? undefined : originOf(delivered)).toEqual(origin);

      expect(yield* refusal(planner.id, "send_message", { threadId: planner.id, text: "me" })).toBe(
        "A thread can't send a message to itself.",
      );
      expect(
        yield* refusal(planner.id, "send_message", { threadId: worker.id, text: "Again?" }),
      ).toContain("already came from this thread");

      yield* (yield* sessionOf(worker.id)).completeTurn();
      yield* statusIs(worker.id, "idle");
      yield* runtimes.send(worker.id, { text: "A note from the user." });
      yield* (yield* sessionOf(worker.id)).completeTurn();
      yield* statusIs(worker.id, "idle");
      expect(
        yield* run(planner.id, "send_message", { threadId: worker.id, text: "One more." }),
      ).toMatchObject({ delivered: "sent" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it("joins queued messages in order, counted by the runtime rather than read from the text", () => {
    const origin = { threadId: "o" as ThreadId, title: "Orchestrator", depth: 1 };
    const at = Date.UTC(2026, 8, 25, 14, 2);
    const preface =
      "These are separate messages, oldest first. A later one may change an earlier one.";
    const two = joinMessages(
      { input: { text: "One.", origin }, queuedAt: undefined, messages: 1 },
      { text: "Two." },
      at,
    );
    expect(two).toEqual({
      text: `${preface}\n\n── Message 1 ──\nOne.\n\n── Message 2, sent 14:02 UTC ──\nTwo.`,
      origin,
    });
    const three = joinMessages(
      { input: two, queuedAt: at, messages: 2 },
      { text: "Three." },
      at + 60_000,
    );
    expect(three.text.endsWith("Two.\n\n── Message 3, sent 14:03 UTC ──\nThree.")).toBe(true);
    // A first message that reads like a joined item is still wrapped as one message.
    const lookalike = `${preface}\n── Message 7 ──\n── Message 8 ──`;
    const joined = joinMessages(
      { input: { text: lookalike, origin }, queuedAt: at, messages: 1 },
      { text: "Next." },
      at,
    );
    expect(joined.text).toBe(
      `${preface}\n\n── Message 1, sent 14:02 UTC ──\n${lookalike}\n\n── Message 2, sent 14:02 UTC ──\nNext.`,
    );

    // One reason to wait holds for the row only while every message in it shares it.
    const steered = { ...origin, mode: "steer" as const };
    const same = joinMessages(
      { input: { text: "A.", origin: steered }, queuedAt: at, messages: 1 },
      { text: "B.", origin: steered },
      at,
    );
    expect(same.origin).toEqual(steered);
    const mixed = joinMessages(
      { input: { text: "A.", origin: steered }, queuedAt: at, messages: 1 },
      { text: "B.", origin: { ...origin, mode: "queue" } },
      at,
    );
    expect(mixed.origin).toEqual(origin);
  });

  it("holds off archiving a thread its pull request or a monitor would still wake", () => {
    const bound = { repo: "o/r", number: 7, monitor: false };
    const open = badge("o/r", 7, "OPEN");
    expect(archiveHold({}, undefined)).toBeUndefined();
    expect(archiveHold({}, open)).toBe("its pull request #7 is open");
    expect(archiveHold({ boundPr: bound }, open)).toBe("its pull request o/r#7 is open");
    expect(archiveHold({ boundPr: bound }, badge("o/r", 7, "MERGED"))).toBeUndefined();
    // A badge still showing a PR bound before is no word on this one, even by the same number.
    expect(archiveHold({ boundPr: bound }, badge("o/r", 3, "OPEN"))).toBeUndefined();
    const watched = { boundPr: { ...bound, reviewMonitor: true } };
    expect(archiveHold(watched, badge("o/other", 7, "MERGED"))).toBe(
      "it is monitoring pull request o/r#7",
    );
    expect(archiveHold(watched, badge("o/r", 7, "CLOSED"))).toBeUndefined();
    expect(archiveHold({ babysit: initialBabysitState(0) }, undefined)).toBe(
      "it is babysitting its pull request",
    );

    // Every extra PR counts on its own badge: a merged main PR doesn't clear an open extra.
    const extra = { repo: "o/web", number: 7, monitor: true };
    const multi = { boundPr: bound, extraPrs: [extra] };
    const merged = badge("o/r", 7, "MERGED");
    expect(archiveHold(multi, merged, [badge("o/web", 7, "OPEN")])).toBe(
      "its pull request o/web#7 is open",
    );
    expect(archiveHold(multi, merged)).toBe("it is monitoring pull request o/web#7");
    expect(archiveHold(multi, merged, [badge("o/web", 7, "MERGED")])).toBeUndefined();
  });

  it.effect("steers, stops, switches model, checks effort and archives other threads", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const planner = yield* createThread("Planner");
      const worker = yield* createThread("Worker");
      yield* runtimes.send(worker.id, { text: "A long task." });
      yield* statusIs(worker.id, "running");

      expect(
        yield* run(planner.id, "send_message", {
          threadId: worker.id,
          text: "Also run lint.",
          mode: "steer",
        }),
      ).toMatchObject({ delivered: "steered" });
      const session = yield* sessionOf(worker.id);
      const steerOrigin = {
        threadId: planner.id,
        title: "Planner",
        depth: 1,
        mode: "steer",
      } as const;
      expect(session.steered).toEqual([
        {
          text: fenceThreadMessage(steerOrigin, "Also run lint."),
          origin: steerOrigin,
        },
      ]);

      expect(yield* run(planner.id, "stop_thread", { threadId: worker.id })).toEqual({
        threadId: worker.id,
        stopped: true,
      });
      expect(session.interrupts).toBe(1);
      yield* statusIs(worker.id, "idle");
      expect(yield* run(planner.id, "stop_thread", { threadId: worker.id })).toMatchObject({
        stopped: false,
      });
      expect(yield* refusal(planner.id, "stop_thread", { threadId: planner.id })).toBe(
        "A thread can't stop itself.",
      );

      expect(
        yield* run(planner.id, "set_thread_model", { threadId: worker.id, model: "fake-haiku" }),
      ).toMatchObject({ model: { model: "fake-haiku" } });
      expect((yield* store.getThread(worker.id)).model.model).toBe("fake-haiku");
      expect(
        yield* refusal(planner.id, "set_thread_model", { threadId: worker.id, model: "gpt-9" }),
      ).toContain("gpt-9 isn't available");
      expect(
        yield* refusal(planner.id, "set_thread_effort", { threadId: worker.id, variant: "high" }),
      ).toBe("fake-haiku has no reasoning effort setting.");

      expect(yield* run(planner.id, "archive_thread", { threadId: worker.id })).toEqual({
        threadId: worker.id,
        archived: true,
      });
      expect((yield* store.getThread(worker.id)).parked).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("accepts a model the user added in Settings, with the efforts the picker offers", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const planner = yield* createThread("Planner");
      const worker = yield* createThread("Worker");
      const agent = worker.model.agent;
      yield* store.updateSettings((settings) => ({
        ...settings,
        agents: {
          ...settings.agents,
          customModels: [
            { agent, id: "claude-preview[1m]" },
            { agent, id: "claude-plain", effort: false },
            { agent: agent === "codex" ? "claude" : "codex", id: "someone-elses" },
          ],
        },
      }));

      expect(
        yield* run(planner.id, "set_thread_model", {
          threadId: worker.id,
          model: "claude-preview[1m]",
        }),
      ).toMatchObject({ model: { model: "claude-preview[1m]" } });
      expect(
        yield* run(planner.id, "set_thread_effort", { threadId: worker.id, variant: "high" }),
      ).toEqual({ threadId: worker.id, variant: "high" });
      expect((yield* store.getThread(worker.id)).model.variant).toBe("high");

      // `effort: false` drops the variant on the way over, and refuses one afterwards.
      const plain = yield* run(planner.id, "set_thread_model", {
        threadId: worker.id,
        model: "claude-plain",
      });
      expect(plain).toMatchObject({ model: { model: "claude-plain" } });
      expect((yield* store.getThread(worker.id)).model.variant).toBeUndefined();
      expect(
        yield* refusal(planner.id, "set_thread_effort", { threadId: worker.id, variant: "high" }),
      ).toBe("claude-plain has no reasoning effort setting.");

      expect(
        yield* refusal(planner.id, "set_thread_model", {
          threadId: worker.id,
          model: "someone-elses",
        }),
      ).toContain("someone-elses isn't available");

      // A gateway model that lists no efforts takes every effort, as the picker offers it.
      yield* store.upsertProfile({
        id: ProfileId.make("gw"),
        name: "Gateway",
        baseURL: "https://llm.example.test/v1",
        keyRef: "",
        models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }],
      });
      yield* run(planner.id, "set_thread_model", {
        threadId: worker.id,
        model: "gpt-6.1-sol",
        profileId: "gw",
      });
      expect(
        yield* run(planner.id, "set_thread_effort", { threadId: worker.id, variant: "xhigh" }),
      ).toEqual({ threadId: worker.id, variant: "xhigh" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops a chain after two hops and limits sends per minute", () =>
    Effect.gen(function* () {
      const planner = yield* createThread("Planner");
      const worker = yield* createThread("Worker");
      const reviewer = yield* createThread("Reviewer");

      yield* run(planner.id, "send_message", { threadId: worker.id, text: "Hand this on." });
      yield* run(worker.id, "send_message", { threadId: reviewer.id, text: "Review this." });
      const [review] = yield* userMessages(reviewer.id);
      expect(review === undefined ? undefined : originOf(review)).toMatchObject({
        threadId: worker.id,
        depth: 2,
      });
      expect(
        yield* refusal(reviewer.id, "send_message", { threadId: planner.id, text: "Back." }),
      ).toContain("stop after 2 hops");

      const targets = yield* Effect.forEach(["T1", "T2", "T3", "T4"], createThread);
      for (const target of targets) {
        yield* run(planner.id, "send_message", { threadId: target.id, text: "ping" });
      }
      const sixth = yield* createThread("T6");
      expect(
        yield* refusal(planner.id, "send_message", { threadId: sixth.id, text: "ping" }),
      ).toContain("allows 5 messages a minute");
      yield* TestClock.adjust("61 seconds");
      expect(
        yield* run(planner.id, "send_message", { threadId: sixth.id, text: "ping" }),
      ).toMatchObject({ delivered: "sent" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "raises a card naming the target on every call, whatever was answered before, and honours a decline",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const planner = yield* createThread("Planner");
        const worker = yield* createThread("Worker");
        const reviewer = yield* createThread("Reviewer");

        const send = yield* tool(planner.id, "send_message", true);
        const first = yield* Effect.forkScoped(send.run({ threadId: worker.id, text: "Ship it." }));
        const card = yield* waitFor(
          "the card",
          store.listRequests(planner.id).pipe(Effect.map((requests) => requests[0])),
        );
        expect(card).toMatchObject({
          kind: "approval",
          toolName: "mcp__gram__send_message",
          description: "Send to “Worker”: Ship it.",
          scopes: ["once"],
        });
        yield* runtimes.respond(planner.id, card.id, {
          kind: "approval",
          decision: "allow",
          scope: "session",
        });
        expect(yield* Fiber.join(first)).toMatchObject({ delivered: "sent" });
        const second = yield* Effect.forkScoped(send.run({ threadId: reviewer.id, text: "Look." }));
        const again = yield* waitFor(
          "the second card",
          store.listRequests(planner.id).pipe(Effect.map((requests) => requests[0])),
        );
        expect(again).toMatchObject({ description: "Send to “Reviewer”: Look." });
        yield* runtimes.respond(planner.id, again.id, {
          kind: "approval",
          decision: "allow",
          scope: "once",
        });
        expect(yield* Fiber.join(second)).toMatchObject({ delivered: "sent" });

        const stop = yield* tool(planner.id, "stop_thread", true);
        const declined = yield* Effect.forkScoped(stop.run({ threadId: worker.id }));
        const stopCard = yield* waitFor(
          "the stop card",
          store.listRequests(planner.id).pipe(Effect.map((requests) => requests[0])),
        );
        expect(stopCard).toMatchObject({ description: "Stop “Worker”" });
        yield* runtimes.respond(planner.id, stopCard.id, {
          kind: "approval",
          decision: "deny",
          scope: "once",
        });
        expect(yield* Fiber.join(declined).pipe(Effect.flip)).toMatchObject({
          approvalRequired: true,
        });
        expect((yield* sessionOf(worker.id)).interrupts).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
