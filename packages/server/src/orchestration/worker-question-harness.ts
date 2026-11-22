import type { WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { FakeSession } from "../runtime/fake-agent.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitSent,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

/** Runs `body` in a server over a fresh world. */
export const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

/** A worker's question with two options and a recommendation. */
export const QUESTION = {
  question: "Should a deleted cart answer 404 or 410?",
  context: "Clients cache 404s for a day.",
  options: [
    { label: "404", description: "What the API does today" },
    { label: "410", description: "Gone, so clients drop it" },
  ],
  recommended: "410",
};

/** The outbox's record of question `id`. */
export const stored = (workspaceId: WorkspaceId, id: string) =>
  Effect.map(outboxOf(workspaceId), (outbox) =>
    (outbox.questions ?? []).find((question) => question.id === id),
  );

/** An orchestrator with one worker, its brief's turn still running. */
export const withWorker = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const worker = yield* spawn(opened.session, { feature: "cart", title: "Cart API" });
    yield* completeTurn(opened.session);
    return { ...opened, worker };
  });

/** The next digest the orchestrator is sent, once the window has passed; its turn left running. */
export const nextDigest = (orchestrator: FakeSession) =>
  Effect.gen(function* () {
    const before = orchestrator.sent.length;
    yield* TestClock.adjust("60 seconds");
    yield* settle;
    const session = yield* waitSent(orchestrator.options.threadId, before + 1);
    return session.sent.at(-1)?.text ?? "";
  });

/** The worker asks `input`. */
export const asked = (session: FakeSession, input: Record<string, unknown> = QUESTION) =>
  session.callTool("ask_question", input) as Effect.Effect<{
    readonly asked: boolean;
    readonly id: string;
    readonly stage: string;
  }>;
