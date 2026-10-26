// Shared fixtures for the orchestration service tests, which are split across files so they run side by side.
import { type PrStatus, type ServerEvent, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import {
  makeWorld,
  prBadge,
  waitReal,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

/** One world, one server: what every test but the restart ones runs in. */
export const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

export const texts = (session: FakeSession) => session.sent.map((input) => input.text);

export const sessionsOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions.filter((session) => session.options.threadId === threadId);
  });

/** acme/app#99, which a wake waits on. */
/** Everything the thread's sessions were sent, oldest first. */
export const allSent = (threadId: ThreadId) =>
  sessionsOf(threadId).pipe(
    Effect.map((sessions) => sessions.flatMap((each) => each.sent.map((input) => input.text))),
  );

export const sentCount = (threadId: ThreadId, count: number) =>
  waitReal(
    `${count} sent to ${threadId}`,
    allSent(threadId).pipe(Effect.map((sent) => sent.length >= count && sent)),
  );

export const otherBadge = (overrides: Partial<PrStatus> = {}) =>
  prBadge({
    number: 99,
    url: "https://github.com/acme/app/pull/99",
    headRefOid: "h1",
    ...overrides,
  });

/** acme/app#100, which a worker's PR depends on. */
export const baseBadge = (overrides: Partial<PrStatus> = {}) =>
  prBadge({
    number: 100,
    url: "https://github.com/acme/app/pull/100",
    headRefOid: "d1",
    headRef: "feat/base",
    ...overrides,
  });

export const notifications = (events: ReadonlyArray<ServerEvent>) =>
  events.flatMap((event) => (event.type === "notify" ? [event.title] : []));
