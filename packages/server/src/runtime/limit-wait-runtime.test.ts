// Waiting out a provider limit, against the fake agent and the test clock. Every thread runs on
// the fake's own login with no gateway profile, so all of them share one account.
import { describe, expect, it } from "@effect/vitest";
import {
  fenceThreadMessage,
  type AgentEvent,
  type AgentFailure,
  type OrchestrationDigest,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_ATTEMPTS,
  BACKOFF_MAX_DELAY_MS,
  LIMIT_HELD_RECHECK_MS,
  LIMIT_RESUME_BATCH_GAP_MS,
  LIMIT_RESUME_DELAY_MS,
  LIMIT_RESUME_JITTER_MS,
  LIMIT_CLEARED_TEXT,
  LIMIT_EARLY_GAP_MS,
  LIMIT_RESUME_TEXT,
} from "./limit-wait.ts";
import { recordingDelivery, RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// 11:00 in Oslo; Claude's message below says the limit lifts at 12:50 there.
const NOW = Date.parse("2026-10-15T09:00:00Z");
const RESET = Date.parse("2026-10-15T10:50:00Z");
/** Past every first-batch resume: the reset, the delay and the most jitter. */
const FIRST_BATCH = RESET + LIMIT_RESUME_DELAY_MS + LIMIT_RESUME_JITTER_MS + 1;

const CLAUDE_LIMIT: AgentEvent = {
  type: "turnEnd",
  reason: "error",
  error: "You've hit your session limit · resets 12:50pm (Europe/Oslo)",
  failure: { kind: "rateLimit", httpStatus: 429, code: "rate_limit", retryable: true },
};
const BARE_429: AgentFailure = { kind: "rateLimit", httpStatus: 429, retryable: true };

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
});

/** The thread's session once the runtime has opened one. */
const sessionOf = (threadId: ThreadId) =>
  FakeAgentControl.pipe(
    Effect.flatMap((fake) =>
      waitFor(
        "session",
        fake.latest(threadId).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
        ),
      ),
    ),
  );

const texts = (session: FakeSession) => session.sent.map((input) => input.text);

/**
 * Every message the thread's sessions were sent, oldest first: a wait outlasts the idle timer, so
 * the resume reopens the conversation in a session of its own.
 */
const sentTo = (threadId: ThreadId) =>
  FakeAgentControl.pipe(
    Effect.map((fake) =>
      fake.sessions
        .filter((session) => session.options.threadId === threadId)
        .flatMap((session) => texts(session)),
    ),
  );

const waitSent = (threadId: ThreadId, count: number) =>
  waitFor(`${count} sent`, sentTo(threadId).pipe(Effect.map((sent) => sent.length === count)));

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

let threadCount = 0;
/**
 * A fixed id for each thread the file creates. A thread's resume jitter comes from its id, from 0
 * to `LIMIT_RESUME_JITTER_MS`, and at 0 an early release resumes it at once: random ids made about
 * one run in 10,000 fail where a test reads the wait between that release and its resume.
 */
const nextThreadId = () =>
  `00000000-0000-4000-8000-${(++threadCount).toString(16).padStart(12, "0")}` as ThreadId;

/** A thread mid-way through the user's first turn, "one". */
const running = (role?: "orchestrator") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      id: nextThreadId(),
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text: "one" },
      ...(role === undefined ? {} : { role }),
    });
    const session = yield* sessionOf(thread.id);
    yield* waitFor(
      "first send",
      Effect.sync(() => session.sent.length === 1),
    );
    return { thread, session };
  });

/** The thread's current turn stops on `end`, and the adapter reports idle as Claude's and Codex's do. */
const fail = (threadId: ThreadId, end: AgentEvent) =>
  sessionOf(threadId).pipe(
    Effect.flatMap((session) => session.emit(end, { type: "status", status: "idle" })),
    Effect.andThen(settle),
  );

/** The thread's current turn completes. */
const complete = (threadId: ThreadId) =>
  sessionOf(threadId).pipe(Effect.flatMap((session) => session.completeTurn()));

const waitOf = (threadId: ThreadId) =>
  ThreadStore.pipe(
    Effect.flatMap((store) => store.getThread(threadId)),
    Effect.map((thread) => thread.limitWait),
  );

const digest = (text: string) => ({
  text,
  notice: { kind: "orchestration" } as OrchestrationDigest,
});

describe("limit wait", () => {
  it.effect("waits out Claude's session limit and resumes once, after the reset", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* running();
      yield* fail(thread.id, CLAUDE_LIMIT);

      // Before: `error`, a red card and nothing more. Now it rests, waiting, with no error at all.
      expect(yield* runtimes.status(thread.id)).toBe("idle");
      const stored = yield* store.getThread(thread.id);
      expect(stored.lastError).toBeUndefined();
      expect(stored.limitWait).toMatchObject({ kind: "limit", resetsAt: RESET, attempt: 0 });
      const parts = (yield* store.listMessages(thread.id)).flatMap((m) => m.parts);
      expect(parts.some((part) => part.type === "data-agent-error")).toBe(false);

      // A message from another thread waits for the resume.
      const origin = { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 };
      const sent = yield* runtimes.send(thread.id, { text: "from the orchestrator", origin });
      expect(sent.queued).toBe(true);
      yield* TestClock.setTime(RESET);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);

      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(thread.id, 2);
      expect(yield* waitOf(thread.id)).toBeUndefined();
      yield* complete(thread.id);
      yield* waitSent(thread.id, 3);
      yield* complete(thread.id);
      yield* settle;
      // Nothing sent twice: the interrupted message isn't resent, only "continue" and the queue.
      expect(yield* sentTo(thread.id)).toEqual([
        "one",
        LIMIT_RESUME_TEXT,
        fenceThreadMessage(origin, "from the orchestrator"),
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("takes Codex's reset from the rejected reading when its message names none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { thread, session } = yield* running();
      yield* session.emit({
        type: "rateLimit",
        status: "rejected",
        window: "five_hour",
        resetsAt: RESET,
      });
      yield* fail(thread.id, {
        type: "turnEnd",
        reason: "error",
        error: "You've hit your usage limit. Try again later.",
        failure: { kind: "rateLimit", code: "usageLimitExceeded", retryable: false },
      });
      expect(yield* waitOf(thread.id)).toMatchObject({ kind: "limit", resetsAt: RESET });
      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(thread.id, 2);
      expect(yield* sentTo(thread.id)).toEqual(["one", LIMIT_RESUME_TEXT]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("backs off a bare 429, and stops at the cap with an ordinary error", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const store = yield* ThreadStore;
      const { thread } = yield* running();
      const bare: AgentEvent = {
        type: "turnEnd",
        reason: "error",
        error: "Too many requests",
        failure: BARE_429,
      };
      const delays: Array<number> = [];
      for (let attempt = 1; attempt <= BACKOFF_MAX_ATTEMPTS; attempt++) {
        yield* fail(thread.id, bare);
        const wait = yield* waitOf(thread.id);
        expect(wait).toMatchObject({ kind: "backoff", attempt });
        delays.push(wait!.resumeAt - (yield* Clock.currentTimeMillis));
        yield* TestClock.setTime(wait!.resumeAt);
        yield* waitSent(thread.id, attempt + 1);
      }
      // Each wait is longer than the one before, up to the cap.
      expect(delays.every((delay, i) => i === 0 || delay > delays[i - 1]!)).toBe(true);
      yield* fail(thread.id, bare);
      expect(yield* waitOf(thread.id)).toBeUndefined();
      expect((yield* store.getThread(thread.id)).lastError?.kind).toBe("rateLimit");
      yield* TestClock.adjust("1 hour");
      yield* settle;
      const sent = yield* sentTo(thread.id);
      expect(sent.filter((text) => text === "one")).toHaveLength(1);
      expect(sent).toHaveLength(BACKOFF_MAX_ATTEMPTS + 1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("resumes the orchestrator first, then workers in batches", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const workers: Array<ThreadId> = [];
      for (let i = 0; i < 4; i++) workers.push((yield* running()).thread.id);
      const orchestrator = (yield* running("orchestrator")).thread.id;
      for (const id of [...workers, orchestrator]) yield* fail(id, CLAUDE_LIMIT);
      const resumed = Effect.gen(function* () {
        let count = 0;
        for (const id of workers) if ((yield* sentTo(id)).length === 2) count++;
        return count;
      });

      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(orchestrator, 2);
      yield* settle;
      expect(yield* resumed).toBe(0);
      yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitFor("first batch", resumed.pipe(Effect.map((count) => count === 3)));
      yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitFor("second batch", resumed.pipe(Effect.map((count) => count === 4)));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("resumes at the reset the latest limit named, not a sibling's later one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const worker = (yield* running()).thread.id;
      const orchestrator = (yield* running("orchestrator")).thread.id;
      // A worker met the weekly limit; its wait still names that reset when the session limit
      // comes, though the week may have lifted since.
      const weekly = Date.parse("2026-10-19T20:00:00Z");
      yield* fail(worker, {
        ...CLAUDE_LIMIT,
        error: "You've hit your weekly limit · resets Oct 19, 10pm (Europe/Oslo)",
      });
      expect(yield* waitOf(worker)).toMatchObject({ resetsAt: weekly });
      yield* fail(orchestrator, CLAUDE_LIMIT);

      // Before: the account went on the later reset, so the orchestrator said "resumes 22:00" and
      // waited four days for a limit that lifts at 12:50.
      expect(yield* waitOf(orchestrator)).toMatchObject({ resetsAt: RESET });
      expect((yield* waitOf(orchestrator))!.resumeAt).toBeLessThan(FIRST_BATCH);
      expect(yield* waitOf(worker)).toMatchObject({ resetsAt: RESET });
      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(orchestrator, 2);
      yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitSent(worker, 2);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("holds digests at a limited thread and sends the newest as the resume, once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* running("orchestrator");
      yield* fail(thread.id, CLAUDE_LIMIT);
      const first = recordingDelivery(digest("digest 1"));
      const second = recordingDelivery(digest("digest 2"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", first.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "digest", second.delivery);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);

      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(thread.id, 2);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one", "digest 2"]);
      expect(first.calls).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("settles a digest whose own turn meets the limit as limited, not failed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* running("orchestrator");
      yield* complete(thread.id);
      yield* waitStatus(thread.id, "idle");
      const { delivery, calls } = recordingDelivery({ text: "digest" });
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* waitSent(thread.id, 2);
      yield* fail(thread.id, CLAUDE_LIMIT);
      expect(calls).toEqual(["build", "failed:limited"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves a held thread waiting until the hold lets go", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* running();
      let holding = true;
      yield* runtimes.holdResumes((each) => Effect.succeed(holding && each.id === thread.id));
      yield* fail(thread.id, CLAUDE_LIMIT);

      yield* TestClock.setTime(FIRST_BATCH + 2 * LIMIT_RESUME_BATCH_GAP_MS);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);
      expect(yield* waitOf(thread.id)).toBeDefined();

      holding = false;
      yield* TestClock.adjust(LIMIT_HELD_RECHECK_MS);
      // A worker let go takes the first release batch, a gap on, behind any orchestrator.
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);
      yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitSent(thread.id, 2);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.effect("backs off, bounded, when the limit outlasts the reset it named", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { thread } = yield* running();
      yield* fail(thread.id, CLAUDE_LIMIT);
      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(thread.id, 2);
      // The same words again, now that 12:50 has passed, and again with the clock standing still.
      for (let attempt = 1; attempt <= 2; attempt++) {
        yield* fail(thread.id, CLAUDE_LIMIT);
        const wait = yield* waitOf(thread.id);
        expect(wait).toMatchObject({ kind: "backoff", attempt });
        expect(wait!.resumeAt - (yield* Clock.currentTimeMillis)).toBeGreaterThanOrEqual(
          BACKOFF_BASE_MS,
        );
        yield* settle;
        expect(yield* sentTo(thread.id)).toHaveLength(attempt + 1);
        yield* TestClock.setTime(wait!.resumeAt);
        yield* waitSent(thread.id, attempt + 2);
      }
      // A reading that only repeats the reset already gone by says nothing fresher either: a usage
      // limit with no reset still to come waits, never resumes at once.
      const session = yield* sessionOf(thread.id);
      yield* session.emit({
        type: "rateLimit",
        status: "rejected",
        window: "five_hour",
        resetsAt: RESET,
      });
      yield* fail(thread.id, {
        type: "turnEnd",
        reason: "error",
        error: "Try again later.",
        failure: { kind: "rateLimit", code: "usageLimitExceeded", retryable: false },
      });
      const last = yield* waitOf(thread.id);
      expect(last!.resumeAt - (yield* Clock.currentTimeMillis)).toBeGreaterThanOrEqual(
        BACKOFF_BASE_MS,
      );
      yield* settle;
      expect(yield* sentTo(thread.id)).toHaveLength(4);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("backs off the same clock-only reset past ten minutes, never to tomorrow", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const store = yield* ThreadStore;
      const { thread } = yield* running();
      yield* fail(thread.id, CLAUDE_LIMIT);
      yield* TestClock.setTime(FIRST_BATCH);
      yield* waitSent(thread.id, 2);
      // The provider keeps saying "resets 12:50pm" well after 12:50 has passed.
      for (let attempt = 1; attempt <= BACKOFF_MAX_ATTEMPTS; attempt++) {
        yield* fail(thread.id, CLAUDE_LIMIT);
        const wait = yield* waitOf(thread.id);
        expect(wait).toMatchObject({ kind: "backoff", attempt, resetsAt: RESET });
        expect(wait!.resumeAt - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(
          BACKOFF_MAX_DELAY_MS + 5000,
        );
        yield* TestClock.setTime(wait!.resumeAt);
        yield* waitSent(thread.id, attempt + 2);
      }
      expect((yield* Clock.currentTimeMillis) - RESET).toBeGreaterThan(10 * 60_000);
      yield* fail(thread.id, CLAUDE_LIMIT);
      expect(yield* waitOf(thread.id)).toBeUndefined();
      expect((yield* store.getThread(thread.id)).lastError?.kind).toBe("rateLimit");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a cancelled wait's queue and deliveries held, a restart included", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* running("orchestrator");
      yield* fail(thread.id, CLAUDE_LIMIT);
      yield* runtimes.cancelLimitWait(thread.id);
      expect(yield* waitOf(thread.id)).toMatchObject({ kind: "limit", cancelled: true });

      yield* runtimes.send(thread.id, {
        text: "from a worker",
        origin: { threadId: "w" as ThreadId, title: "Worker", depth: 1 },
      });
      const held = recordingDelivery(digest("digest"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", held.delivery);
      yield* runtimes.sendQueuedAtBoot;
      yield* TestClock.setTime(FIRST_BATCH + 3 * LIMIT_RESUME_BATCH_GAP_MS);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);
      expect(held.calls).toEqual([]);
      expect(yield* waitOf(thread.id)).toMatchObject({ kind: "limit", cancelled: true });

      // Resume now lets it all go.
      yield* runtimes.resumeLimitWait(thread.id);
      yield* waitSent(thread.id, 2);
      expect(yield* waitOf(thread.id)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("cancels a wait, and a user's resume sends at once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const a = (yield* running()).thread.id;
      const b = (yield* running()).thread.id;
      yield* fail(a, CLAUDE_LIMIT);
      yield* fail(b, CLAUDE_LIMIT);

      yield* runtimes.cancelLimitWait(a);
      expect(yield* waitOf(a)).toMatchObject({ cancelled: true });
      expect((yield* store.getThread(a)).lastError?.kind).toBe("rateLimit");

      yield* runtimes.resumeLimitWait(b);
      yield* waitSent(b, 2);

      yield* TestClock.setTime(FIRST_BATCH + 3 * LIMIT_RESUME_BATCH_GAP_MS);
      yield* settle;
      expect(yield* sentTo(a)).toHaveLength(1);
      expect(yield* sentTo(b)).toHaveLength(2);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a new thread's first message while its account is limited", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const first = (yield* running()).thread.id;
      yield* fail(first, CLAUDE_LIMIT);
      const origin = { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 };
      const spawned = yield* runtimes.create({
        id: nextThreadId(),
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "brief", origin },
      });
      yield* settle;
      expect(yield* waitOf(spawned.id)).toMatchObject({ kind: "limit", resetsAt: RESET });
      expect(yield* sentTo(spawned.id)).toEqual([]);
      yield* TestClock.setTime(FIRST_BATCH + LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitSent(spawned.id, 1);
      // Not this thread's own orchestrator (it has none), so the brief is read fenced.
      expect(yield* sentTo(spawned.id)).toEqual([fenceThreadMessage(origin, "brief")]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
  it.effect("resumes now on the user's word though a sibling still waits on the account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const worker = (yield* running()).thread.id;
      const orchestrator = (yield* running("orchestrator")).thread.id;
      yield* fail(worker, CLAUDE_LIMIT);
      yield* fail(orchestrator, CLAUDE_LIMIT);
      const { delivery } = recordingDelivery(digest("held digest"));
      yield* runtimes.requestSystemDelivery(orchestrator, "digest", delivery);
      yield* runtimes.resumeLimitWait(orchestrator);
      yield* waitSent(orchestrator, 2);
      expect(yield* waitOf(orchestrator)).toBeUndefined();
      expect(yield* sentTo(orchestrator)).toEqual(["one", "held digest"]);
      // The worker still waits for its own turn.
      expect(yield* waitOf(worker)).toMatchObject({ kind: "limit" });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a cancelled wait cancelled when a sibling's limit still holds the account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const worker = (yield* running()).thread.id;
      const orchestrator = (yield* running("orchestrator")).thread.id;
      yield* fail(worker, CLAUDE_LIMIT);
      yield* fail(orchestrator, CLAUDE_LIMIT);
      yield* runtimes.cancelLimitWait(orchestrator);
      const { delivery, calls } = recordingDelivery(digest("later digest"));
      yield* runtimes.requestSystemDelivery(orchestrator, "digest", delivery);
      yield* settle;
      expect(yield* waitOf(orchestrator)).toMatchObject({ cancelled: true });
      yield* TestClock.setTime(FIRST_BATCH + 3 * LIMIT_RESUME_BATCH_GAP_MS);
      yield* settle;
      expect(yield* sentTo(orchestrator)).toEqual(["one"]);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("paces workers a hold let go together, after their orchestrator", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const workers: Array<ThreadId> = [];
      for (let i = 0; i < 4; i++) workers.push((yield* running()).thread.id);
      const orchestrator = (yield* running("orchestrator")).thread.id;
      let paused = true;
      yield* runtimes.holdResumes(() => Effect.succeed(paused));
      for (const id of [...workers, orchestrator]) yield* fail(id, CLAUDE_LIMIT);
      yield* TestClock.setTime(FIRST_BATCH + 3 * LIMIT_RESUME_BATCH_GAP_MS);
      yield* settle;
      paused = false;
      const firstSent = new Map<ThreadId, number>();
      for (let step = 0; step < 80; step++) {
        yield* TestClock.adjust(5000);
        yield* settle;
        const now = yield* Clock.currentTimeMillis;
        for (const id of [...workers, orchestrator]) {
          if (!firstSent.has(id) && (yield* sentTo(id)).length === 2) firstSent.set(id, now);
        }
      }
      expect(firstSent.size).toBe(5);
      const times = workers.map((id) => firstSent.get(id)!).toSorted((a, b) => a - b);
      expect(firstSent.get(orchestrator)!).toBeLessThan(times[0]!);
      // Never more than a batch within one gap.
      for (let i = 3; i < times.length; i++) {
        expect(times[i]! - times[i - 3]!).toBeGreaterThanOrEqual(LIMIT_RESUME_BATCH_GAP_MS);
      }
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );
});

/**
 * The CLI's own account query reads Claude's windows at these shares, as the limit poller does.
 * The 5-hour window resets `fiveHourResetsAt`, by default 4 hours on from the reading.
 */
const polled = (fiveHour: number, weekly: number, credits = false, fiveHourResetsAt?: number) =>
  Effect.gen(function* () {
    const readings = yield* UsageLimitReadings;
    const now = yield* Clock.currentTimeMillis;
    const before = yield* readings.current;
    yield* readings.replaceSubscription(
      "claude",
      [
        {
          status: "allowed",
          window: "five_hour",
          utilization: fiveHour,
          resetsAt: fiveHourResetsAt ?? now + 4 * 3_600_000,
          ...(credits ? { credits: true as const } : {}),
        },
        {
          status: "allowed",
          window: "seven_day",
          utilization: weekly,
          resetsAt: now + 5 * 86_400_000,
        },
      ],
      before,
    );
    yield* settle;
  });

/** Past the first batch of an early release: its jitter, at most. */
const EARLY_FIRST_BATCH = LIMIT_RESUME_JITTER_MS + 1;

const threadOf = (threadId: ThreadId) =>
  ThreadStore.pipe(Effect.flatMap((store) => store.getThread(threadId)));

describe("a limit that no longer applies", () => {
  it.effect("ends the waits early when fresh readings show another account well below it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const first = (yield* running()).thread.id;
      const second = (yield* running()).thread.id;
      yield* fail(first, CLAUDE_LIMIT);
      yield* fail(second, CLAUDE_LIMIT);
      expect(yield* waitOf(first)).toMatchObject({ kind: "limit", resetsAt: RESET });

      // The user switched Claude Code to another login: 16% of 5 hours, 1% of the week.
      yield* TestClock.adjust("2 minutes");
      yield* polled(0.16, 0.01);
      // Before: both still said "resumes 12:50" and waited for it, or for the user's click.
      expect(yield* waitOf(first)).toMatchObject({ kind: "limit", cleared: expect.any(Number) });
      expect((yield* waitOf(first))!.resumeAt).toBeLessThan(RESET);

      yield* TestClock.adjust(EARLY_FIRST_BATCH);
      yield* waitSent(first, 2);
      yield* waitSent(second, 2);
      expect(yield* sentTo(first)).toEqual(["one", LIMIT_CLEARED_TEXT]);
      const thread = yield* threadOf(first);
      expect(thread.limitWait).toBeUndefined();
      expect(thread.limitCleared).toMatchObject({ resetsAt: RESET });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the wait while the readings still show the limit, or none came since", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { thread } = yield* running();
      // Read before the limit: says nothing of it.
      yield* polled(0.4, 0.2);
      yield* TestClock.adjust("1 minute");
      yield* fail(thread.id, CLAUDE_LIMIT);
      yield* settle;
      expect(yield* waitOf(thread.id)).toMatchObject({ kind: "limit", resetsAt: RESET });
      expect((yield* waitOf(thread.id))!.cleared).toBeUndefined();

      // The same account, still full: Claude's own query says "allowed" at 100% all the same.
      yield* TestClock.adjust("1 minute");
      yield* polled(1, 0.4);
      const wait = yield* waitOf(thread.id);
      expect(wait).toMatchObject({ kind: "limit", resetsAt: RESET });
      expect(wait!.cleared).toBeUndefined();
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "waits again for the reset when the resumed turn meets the limit, and doesn't loop",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const { thread } = yield* running();
        yield* fail(thread.id, CLAUDE_LIMIT);
        yield* TestClock.adjust("1 minute");
        yield* polled(0.2, 0.1);
        yield* TestClock.adjust(EARLY_FIRST_BATCH);
        yield* waitSent(thread.id, 2);

        // A limit the readings can't see (a model's own window, say): met again at once.
        yield* fail(thread.id, CLAUDE_LIMIT);
        const again = yield* waitOf(thread.id);
        // The same reset, a limit to wait for: not mistaken for one outlasted, which backs off.
        expect(again).toMatchObject({ kind: "limit", resetsAt: RESET });
        expect(again!.cleared).toBeUndefined();
        expect((yield* threadOf(thread.id)).limitCleared).toBeUndefined();

        // The readings still look low, but the next early try is spaced out.
        yield* TestClock.adjust("1 minute");
        yield* polled(0.2, 0.1);
        expect((yield* waitOf(thread.id))!.cleared).toBeUndefined();
        yield* TestClock.adjust("5 minutes");
        yield* settle;
        expect(yield* sentTo(thread.id)).toHaveLength(2);
        // Past the gap, a fresh reading tries once more.
        yield* TestClock.adjust(LIMIT_EARLY_GAP_MS);
        yield* polled(0.2, 0.1);
        expect((yield* waitOf(thread.id))!.cleared).toEqual(expect.any(Number));
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "ends the waits once the CLI is signed in to another login, though a release met the limit",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const ids: Array<ThreadId> = [];
        for (let i = 0; i < 7; i++) ids.push((yield* running()).thread.id);
        for (const id of ids) yield* fail(id, CLAUDE_LIMIT);

        // The old login reads 97%, below the limit: an early release. Its first batch goes, and
        // the first turn back meets the limit again; every wait still standing goes back to 12:50.
        yield* TestClock.adjust("1 minute");
        yield* polled(0.97, 0.4, false, RESET);
        yield* TestClock.adjust(EARLY_FIRST_BATCH);
        yield* waitFor(
          "first batch",
          Effect.forEach(ids, sentTo).pipe(
            Effect.map((sent) => sent.filter((each) => each.length === 2).length === 3),
          ),
        );
        let first: ThreadId | undefined;
        for (const id of ids)
          if (first === undefined && (yield* waitOf(id)) === undefined) first = id;
        yield* fail(first!, CLAUDE_LIMIT);
        const waiting: Array<ThreadId> = [];
        for (const id of ids) {
          const wait = yield* waitOf(id);
          if (wait === undefined) continue;
          waiting.push(id);
          expect(wait).toMatchObject({ kind: "limit", resetsAt: RESET });
          expect(wait.cleared).toBeUndefined();
        }
        expect(waiting).toHaveLength(5);

        // The user signs Claude Code in to another login: its own windows, barely used. The
        // old login's readings, the same windows a minute later, still release nothing.
        yield* TestClock.adjust("1 minute");
        yield* polled(0.97, 0.4, false, RESET);
        expect((yield* waitOf(first!))!.cleared).toBeUndefined();
        yield* TestClock.adjust("1 minute");
        const switched = yield* Clock.currentTimeMillis;
        yield* polled(0, 0, false, switched + 5 * 3_600_000);
        // Before: every wait still said 12:50 until the spacing (`LIMIT_EARLY_GAP_MS`) was past.
        for (const id of waiting) {
          expect((yield* waitOf(id))!.cleared).toEqual(expect.any(Number));
        }
        // Staggered as an early release always is: the first batch now, the rest a batch gap on.
        const resumeAts = [];
        for (const id of waiting) resumeAts.push((yield* waitOf(id))!.resumeAt);
        expect(Math.min(...resumeAts)).toBeLessThan(switched + EARLY_FIRST_BATCH);
        expect(Math.max(...resumeAts)).toBeGreaterThanOrEqual(switched + LIMIT_RESUME_BATCH_GAP_MS);
        expect(Math.max(...resumeAts)).toBeLessThan(RESET);
        yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS + EARLY_FIRST_BATCH);
        yield* waitSent(first!, 3);
        expect(yield* sentTo(first!)).toEqual(["one", LIMIT_CLEARED_TEXT, LIMIT_CLEARED_TEXT]);
        for (const id of waiting) {
          yield* waitFor("resumed", waitOf(id).pipe(Effect.map((wait) => wait === undefined)));
        }
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a held thread waiting when another login's readings end its wait", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* running();
      let holding = true;
      yield* runtimes.holdResumes((each) => Effect.succeed(holding && each.id === thread.id));
      yield* fail(thread.id, CLAUDE_LIMIT);
      yield* TestClock.adjust("1 minute");
      yield* polled(0, 0, false, NOW + 5 * 3_600_000);
      expect((yield* waitOf(thread.id))!.cleared).toEqual(expect.any(Number));
      // The user's hold wins: the limit no longer applies, but the thread stays put.
      yield* TestClock.adjust(3 * LIMIT_HELD_RECHECK_MS);
      yield* settle;
      expect(yield* sentTo(thread.id)).toEqual(["one"]);
      holding = false;
      yield* TestClock.adjust(LIMIT_HELD_RECHECK_MS + LIMIT_RESUME_BATCH_GAP_MS);
      yield* waitSent(thread.id, 2);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.effect("starts a new thread at once when fresh readings contradict a sibling's wait", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const first = (yield* running()).thread.id;
      yield* fail(first, CLAUDE_LIMIT);
      // A sibling is let go in a later batch, so its wait still stands when the spawn comes.
      const held = (yield* running()).thread.id;
      yield* fail(held, CLAUDE_LIMIT);
      yield* TestClock.adjust("1 minute");
      yield* polled(0.16, 0.01);
      expect(yield* waitOf(held)).toBeDefined();
      const origin = { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 };
      const spawned = yield* runtimes.create({
        id: nextThreadId(),
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "brief", origin },
      });
      yield* settle;
      // Before: queued into the same wait, "resumes at about 12:50".
      expect(yield* waitOf(spawned.id)).toBeUndefined();
      yield* waitSent(spawned.id, 1);
      // Not this thread's own orchestrator (it has none), so the brief is read fenced.
      expect(yield* sentTo(spawned.id)).toEqual([fenceThreadMessage(origin, "brief")]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("ends the waits when a turn on the account goes through", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const waiting = (yield* running()).thread.id;
      yield* fail(waiting, CLAUDE_LIMIT);
      const other = (yield* running()).thread.id;
      yield* fail(other, CLAUDE_LIMIT);
      // The user's own word on one goes through the limit, and its turn completes.
      yield* TestClock.adjust("3 minutes");
      yield* runtimes.send(other, { text: "go on" });
      yield* waitSent(other, 2);
      yield* complete(other);
      yield* settle;
      expect(yield* waitOf(waiting)).toMatchObject({ cleared: expect.any(Number) });
      yield* TestClock.adjust(EARLY_FIRST_BATCH);
      yield* waitSent(waiting, 2);
      expect(yield* sentTo(waiting)).toEqual(["one", LIMIT_CLEARED_TEXT]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "ends the waits on a turn that began before a thread only waited with the account",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const runtimes = yield* ThreadRuntimes;
        const waiting = (yield* running()).thread.id;
        yield* fail(waiting, CLAUDE_LIMIT);
        const other = (yield* running()).thread.id;
        yield* fail(other, CLAUDE_LIMIT);
        yield* TestClock.adjust("3 minutes");
        yield* runtimes.send(other, { text: "go on" });
        yield* waitSent(other, 2);
        // While that turn runs, a new worker is held back with the account: it met no limit.
        yield* TestClock.adjust("1 minute");
        const spawned = yield* runtimes.create({
          id: nextThreadId(),
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: {
            text: "brief",
            origin: { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 },
          },
        });
        yield* settle;
        expect(yield* waitOf(spawned.id)).toMatchObject({ kind: "limit", resetsAt: RESET });
        yield* complete(other);
        yield* settle;
        // Before: the turn opened before that wait began, so it was taken as no proof at all.
        expect(yield* waitOf(waiting)).toMatchObject({ cleared: expect.any(Number) });
        expect(yield* waitOf(spawned.id)).toMatchObject({ cleared: expect.any(Number) });
        yield* TestClock.adjust(EARLY_FIRST_BATCH);
        yield* waitSent(waiting, 2);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves a wait on another model's own limit when this model's turn goes through", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const opus = (yield* running()).thread.id;
      yield* fail(opus, CLAUDE_LIMIT);
      yield* TestClock.adjust("1 minute");
      const haiku = yield* runtimes.create({
        id: nextThreadId(),
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        model: { agent: "claude", model: "fake-haiku" },
        input: { text: "haiku work" },
      });
      yield* waitSent(haiku.id, 1);
      yield* complete(haiku.id);
      yield* settle;
      // Another model's turn says nothing of Opus's own window.
      expect((yield* waitOf(opus))!.cleared).toBeUndefined();
      yield* TestClock.adjust(EARLY_FIRST_BATCH);
      yield* settle;
      expect(yield* sentTo(opus)).toEqual(["one"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps waits a turn released going when a new thread starts on the account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const ids: Array<ThreadId> = [];
      // Enough waits for a second batch, which still waits when the new thread comes.
      for (let i = 0; i < 5; i++) ids.push((yield* running()).thread.id);
      for (const id of ids) yield* fail(id, CLAUDE_LIMIT);
      const other = ids.pop()!;
      yield* TestClock.adjust("3 minutes");
      yield* runtimes.send(other, { text: "go on" });
      yield* waitSent(other, 2);
      yield* complete(other);
      yield* settle;
      for (const id of ids) expect((yield* waitOf(id))!.cleared).toEqual(expect.any(Number));
      const resumeAts = new Map<ThreadId, number>();
      for (const id of ids) resumeAts.set(id, (yield* waitOf(id))!.resumeAt);
      // No reading came: the turn alone said the account takes turns.
      const spawned = yield* runtimes.create({
        id: nextThreadId(),
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: {
          text: "brief",
          origin: { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 },
        },
      });
      yield* settle;
      expect(yield* waitOf(spawned.id)).toBeUndefined();
      yield* waitSent(spawned.id, 1);
      // The released waits keep their early times, not the reset.
      for (const id of ids) {
        const wait = yield* waitOf(id);
        if (wait !== undefined) expect(wait.resumeAt).toBe(resumeAts.get(id));
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never waits on a full window the agent goes on past on credits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const { session } = yield* running();
      // Claude past its 5-hour window, on extra usage: no refusal, just a full meter.
      yield* session.emit({
        type: "rateLimit",
        status: "allowed",
        window: "five_hour",
        utilization: 1,
        resetsAt: RESET,
        credits: true,
      });
      yield* settle;
      const spawned = yield* runtimes.create({
        id: nextThreadId(),
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: {
          text: "brief",
          origin: { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 },
        },
      });
      yield* settle;
      expect(yield* waitOf(spawned.id)).toBeUndefined();
      yield* waitSent(spawned.id, 1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("takes a turn that went through as the end of an older rejection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const runtimes = yield* ThreadRuntimes;
      const readings = yield* UsageLimitReadings;
      const { thread, session } = yield* running();
      yield* session.emit({
        type: "rateLimit",
        status: "rejected",
        window: "five_hour",
        resetsAt: RESET,
      });
      yield* settle;
      yield* complete(thread.id);
      // A new turn on the account, after the rejection, completes: the account takes turns.
      yield* TestClock.adjust("1 minute");
      yield* runtimes.send(thread.id, { text: "two" });
      yield* waitSent(thread.id, 2);
      yield* complete(thread.id);
      yield* settle;
      const five = (yield* readings.current).find((each) => each.window === "five_hour");
      expect(five).toMatchObject({ status: "allowed", utilization: 1 });
      // So a delivery from another thread goes at once, rather than waiting for 12:50.
      const sent = yield* runtimes.send(thread.id, {
        text: "from the orchestrator",
        origin: { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 },
      });
      expect(sent.queued).toBe(false);
      expect(yield* waitOf(thread.id)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

/** The runtime over a database file, so a test can stop it and start another on the same rows. */
const layerOnFile = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

const databaseFile = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "gram-limit-wait-"));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
  return join(dir, "gram.db");
});

describe("limit wait across a restart", () => {
  it.effect("keeps the batches when the app opens again after the reset", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile;
      yield* TestClock.setTime(NOW);
      const { workers, orchestrator } = yield* Effect.gen(function* () {
        const made: Array<ThreadId> = [];
        for (let i = 0; i < 4; i++) made.push((yield* running()).thread.id);
        const lead = (yield* running("orchestrator")).thread.id;
        for (const id of [...made, lead]) yield* fail(id, CLAUDE_LIMIT);
        return { workers: made, orchestrator: lead };
      }).pipe(Effect.provide(layerOnFile(file)));

      yield* TestClock.setTime(RESET + 3_600_000);
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const resumed = Effect.gen(function* () {
          let count = 0;
          for (const id of workers) if ((yield* sentTo(id)).length > 0) count++;
          return count;
        });
        yield* runtimes.sendQueuedAtBoot;
        yield* TestClock.adjust(LIMIT_RESUME_JITTER_MS + 1);
        yield* waitSent(orchestrator, 1);
        yield* settle;
        expect(yield* resumed).toBe(0);
        yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
        yield* waitFor("first batch", resumed.pipe(Effect.map((count) => count === 3)));
        yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
        yield* waitFor("second batch", resumed.pipe(Effect.map((count) => count === 4)));
      }).pipe(Effect.provide(layerOnFile(file)));
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing a cancelled wait held when the app opens again", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile;
      yield* TestClock.setTime(NOW);
      const id = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread } = yield* running();
        yield* fail(thread.id, CLAUDE_LIMIT);
        yield* runtimes.send(thread.id, {
          text: "queued work",
          origin: { threadId: "orch" as ThreadId, title: "Orchestrator", depth: 1 },
        });
        yield* runtimes.cancelLimitWait(thread.id);
        return thread.id;
      }).pipe(Effect.provide(layerOnFile(file)));
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.sendQueuedAtBoot;
        yield* TestClock.setTime(FIRST_BATCH + 3 * LIMIT_RESUME_BATCH_GAP_MS);
        yield* settle;
        expect(yield* sentTo(id)).toEqual([]);
        expect(yield* waitOf(id)).toMatchObject({ cancelled: true });
      }).pipe(Effect.provide(layerOnFile(file)));
    }).pipe(Effect.scoped),
  );
});
