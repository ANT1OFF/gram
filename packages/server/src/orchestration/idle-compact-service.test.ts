import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type AgentEvent, type ThreadId, type UserInput } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ComposerPresence } from "../runtime/composer-presence.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  waitReal,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// Synthetic: the fake agent stands in for Claude Code with invented usage; no CLI or provider.
const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const MIN = 60_000;
const large = {
  type: "usage",
  tokens: { inputTokens: 4, outputTokens: 900, cacheReadTokens: 400_000, cacheWriteTokens: 3_000 },
  contextTokens: 403_004,
  cacheWrites: { fiveMinute: 0, oneHour: 3_000 },
} as AgentEvent;

const isIdleCompact = (input: UserInput) => input.notice?.kind === "idleCompact";

/** The orchestrator after a large turn of its own, idle; and every input sent to it from then. */
const afterLargeTurn = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const runtimes = yield* ThreadRuntimes;
    const fake = yield* FakeAgentControl;
    yield* runtimes.send(opened.thread.id, { text: "plan the week" });
    const session = yield* waitReal(
      "the user's message",
      Effect.sync(() =>
        fake.sessions
          .filter((s) => s.options.threadId === opened.thread.id)
          .find((s) => s.sent.some((input) => input.text === "plan the week")),
      ),
    );
    yield* session.emit(large);
    yield* completeTurn(session);
    yield* settle;
    const sent = () =>
      fake.sessions.filter((s) => s.options.threadId === opened.thread.id).flatMap((s) => s.sent);
    return { ...opened, sent, fake };
  });

/** Moves the clock in steps, letting the service and the runtime take each one. */
const pass = (ms: number) =>
  Effect.gen(function* () {
    for (let left = ms; left > 0; left -= MIN / 2) {
      yield* TestClock.adjust(Math.min(MIN / 2, left));
      yield* settle;
    }
  });

describe("idle compaction in a workspace", () => {
  it.effect("compacts an idle orchestrator by default, before its cache expires", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, sent, fake, workspaceId } = yield* afterLargeTurn(world);
        yield* pass(54 * MIN);
        expect(sent().filter(isIdleCompact)).toEqual([]);
        yield* pass(2 * MIN);
        expect(sent().filter(isIdleCompact)).toEqual([
          {
            text: "/compact",
            notice: { kind: "idleCompact", contextTokens: 403_004, workspaceId },
          },
        ]);
        // The agent compacts; the orchestrator is owed its boot context with the next digest.
        const session = fake.sessions.findLast((s) => s.options.threadId === thread.id)!;
        expect((yield* outboxOf(workspaceId)).booted).toBe(true);
        yield* session.emit({
          type: "chunk",
          messageId: "m-c",
          chunk: { type: "start", messageId: "m-c" },
        } as AgentEvent);
        yield* session.emit({
          type: "chunk",
          messageId: "m-c",
          chunk: {
            type: "data-compaction",
            id: "compaction:c",
            data: { trigger: "manual", preTokens: 403_004, postTokens: 30_000, at: 1 },
          },
        } as AgentEvent);
        yield* completeTurn(session);
        yield* settle;
        expect((yield* outboxOf(workspaceId)).booted).toBe(false);
        // Nothing to compact twice: the context is the summary now.
        yield* pass(70 * MIN);
        expect(sent().filter(isIdleCompact)).toHaveLength(1);
      }),
    ),
  );

  it.effect("never compacts while a window has a draft for the thread", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, sent } = yield* afterLargeTurn(world);
        const presence = yield* ComposerPresence;
        // The window reports its draft every 30 s, as the renderer does while it has one.
        for (let t = 0; t < 62 * MIN; t += MIN / 2) {
          yield* presence.drafts("window-1", [thread.id as ThreadId]);
          yield* TestClock.adjust(MIN / 2);
          yield* settle;
        }
        expect(sent().filter(isIdleCompact)).toEqual([]);
      }),
    ),
  );

  it.effect("doesn't compact a workspace whose user turned it off", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { sent, workspaceId } = yield* afterLargeTurn(world);
        const orchestration = yield* Orchestration;
        const state = (yield* orchestration.listWorkspaces).find(
          (each) => each.workspace.id === workspaceId,
        );
        yield* orchestration.setCharter(workspaceId, {
          ...(state?.charter ?? DEFAULT_CHARTER),
          idleAutoCompact: false,
        });
        yield* settle;
        yield* pass(62 * MIN);
        expect(sent().filter(isIdleCompact)).toEqual([]);
      }),
    ),
  );
});
