// The wrap-up turn: the one turn a worker that stops without a word is sent, and the stops that
// never get one.
import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { type WrapUpFacts, wrapUpDue, wrapUpText } from "./rules.ts";
import { Orchestration } from "./service.ts";
import { inServer } from "./service-kit.ts";
import {
  completeTurn,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitSent,
  waitStatus,
} from "./test-harness.ts";

/** A worker whose turn ended on its own with nothing queued and no report: a silent stop. */
const silent: WrapUpFacts = {
  reason: "completed",
  synthesized: false,
  queueEmpty: true,
  stopAsked: false,
  reported: false,
  idleCompaction: false,
  limitWait: false,
  parked: false,
  paused: false,
  userIntervened: false,
  pending: [],
  afterWrapUp: false,
  ledgerQuiet: true,
};

describe("wrapUpDue", () => {
  it("sends a silent stop its wrap-up", () => {
    expect(wrapUpDue(silent)).toBe("ended");
    expect(wrapUpDue({ ...silent, reason: "maxTurns" })).toBe("ended");
  });

  it("sends one its orchestrator stopped a wrap-up, even through the interrupt watchdog", () => {
    expect(wrapUpDue({ ...silent, reason: "interrupted", stopAsked: true })).toBe("stopped");
    expect(
      wrapUpDue({ ...silent, reason: "interrupted", stopAsked: true, synthesized: true }),
    ).toBe("stopped");
  });

  const exclusions: ReadonlyArray<[string, Partial<WrapUpFacts>]> = [
    ["the turn reported", { reported: true }],
    ["input is queued behind it", { queueEmpty: false }],
    ["the user paused it", { paused: true }],
    ["the user holds it", { userIntervened: true }],
    ["it is archived or completed", { parked: true }],
    ["it waits out a usage limit", { limitWait: true }],
    ["it waits on a wake, a monitor or a merge when ready", { pending: ["automation"] }],
    ["its PR waits on another", { pending: ["dependency"] }],
    ["a background shell, subagent or workflow still runs", { pending: ["background"] }],
    ["its question is open", { pending: ["question"] }],
    ["a request waits on the user", { pending: ["request"] }],
    ["the turn that ended was its wrap-up", { afterWrapUp: true }],
    ["the ledger doesn't read it as silent", { ledgerQuiet: false }],
    ["Gram opened the turn to compact it", { idleCompaction: true }],
    ["the turn errored", { reason: "error" }],
    ["someone else interrupted it", { reason: "interrupted" }],
    ["a crash or restart ended the turn", { synthesized: true }],
  ];
  for (const [why, facts] of exclusions) {
    it(`sends none when ${why}`, () => {
      expect(wrapUpDue({ ...silent, ...facts })).toBeUndefined();
      // An orchestrator's stop overrides none of them but the interrupt and the synthesized end.
      if (facts.reason !== "interrupted" && facts.synthesized !== true) {
        expect(wrapUpDue({ ...silent, ...facts, stopAsked: true })).toBeUndefined();
      }
    });
  }

  it("asks for what is done, what was ruled out and what remains, and no new work", () => {
    for (const why of ["ended", "stopped"] as const) {
      const text = wrapUpText(why);
      expect(text).toContain("Don't start new work");
      expect(text).toContain("what you tried and ruled out");
      expect(text).toContain("what remains");
      expect(text).toContain("`report`");
    }
    expect(wrapUpText("stopped")).toContain("Your orchestrator stopped you");
  });
});

/** Everything `threadId`'s sessions were sent, in order. */
const sentTo = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions
      .filter((session) => session.options.threadId === threadId)
      .flatMap((session) => session.sent.map((input) => input.text));
  });

const wrapUpsTo = (threadId: ThreadId) =>
  sentTo(threadId).pipe(
    Effect.map((texts) => texts.filter((text) => text.includes("Don't start new work")).length),
  );

describe.skipIf(!hasGit)("the wrap-up turn", () => {
  it.effect("asks a silent worker for a report, and the digest carries that report", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* completeTurn(a.session);
        const worker = yield* waitSent(a.thread.id, 2);
        expect(worker.sent[1]!.text).toBe(wrapUpText("ended"));
        // The stop alone wakes nobody: its report is on the way.
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        yield* worker.callTool("report", {
          state: "blocked",
          summary: "Parser done; the IMAP idea is ruled out; the retry loop remains.",
        });
        yield* completeTurn(worker);
        yield* TestClock.adjust("60 seconds");
        const digest = (yield* waitSent(orchestrator, 2)).sent[1]!.text;
        expect(digest).toContain("the IMAP idea is ruled out");
        expect(digest).not.toContain("without reporting");
        expect(yield* wrapUpsTo(a.thread.id)).toBe(1);
      }),
    ),
  );

  it.effect("sends one per stop: a silent wrap-up is told as silent, and gets no second", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session, workspaceId } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* completeTurn(a.session);
        const worker = yield* waitSent(a.thread.id, 2);
        yield* waitStatus(a.thread.id, "running");
        yield* completeTurn(worker);
        yield* TestClock.adjust("60 seconds");
        const digest = (yield* waitSent(orchestrator, 2)).sent[1]!.text;
        expect(digest).toContain("ended its turn without reporting");
        expect(yield* wrapUpsTo(a.thread.id)).toBe(1);
        expect((yield* outboxOf(workspaceId)).workers[a.thread.id]?.wrapUp).toBeUndefined();
        yield* completeTurn(session);
        // A later stop is a stop of its own, and gets its own.
        yield* session.callTool("send_message", { threadId: a.thread.id, text: "Go on." });
        yield* completeTurn(yield* waitSent(a.thread.id, 3));
        yield* waitSent(a.thread.id, 4);
        expect(yield* wrapUpsTo(a.thread.id)).toBe(2);
      }),
    ),
  );

  it.effect("tells a worker its orchestrator stopped that it was stopped", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* waitStatus(a.thread.id, "running");
        expect(yield* session.callTool("stop_thread", { threadId: a.thread.id })).toMatchObject({
          stopped: true,
        });
        const worker = yield* waitSent(a.thread.id, 2);
        expect(worker.sent[1]!.text).toBe(wrapUpText("stopped"));
      }),
    ),
  );

  it.effect("sends none when someone other than its orchestrator interrupts it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* waitStatus(a.thread.id, "running");
        yield* (yield* ThreadRuntimes).interrupt(a.thread.id);
        yield* waitStatus(a.thread.id, "idle");
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
      }),
    ),
  );

  it.effect("sends none to a worker the user typed into since its last report", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* waitStatus(a.thread.id, "running");
        yield* (yield* ThreadRuntimes).steer(a.thread.id, { text: "Use the other inbox." });
        yield* completeTurn(a.session);
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
      }),
    ),
  );

  it.effect("sends none to a worker in a paused feature", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session, workspaceId } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* (yield* Orchestration).setFeaturePaused(workspaceId, "mail", true);
        yield* completeTurn(a.session);
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
      }),
    ),
  );

  it.effect("sends none to a worker waiting on a wake it scheduled", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* a.session.callTool("schedule_wake", { inMinutes: 30, note: "check CI" });
        yield* completeTurn(a.session);
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
      }),
    ),
  );

  it.effect("sends none while a background shell it started still runs, and one once it ends", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* a.session.emit({
          type: "backgroundTasks",
          tasks: [{ taskId: "build", kind: "shell", description: "the build", startedAt: 0 }],
        });
        yield* settle;
        yield* completeTurn(a.session);
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
        // Its result opens a turn; that one ends with nothing left running and no word.
        yield* a.session.emit({ type: "backgroundTasks", tasks: [] });
        yield* (yield* ThreadRuntimes).send(a.thread.id, {
          text: "The build finished.",
          origin: {
            threadId: session.options.threadId,
            title: "o",
            depth: 1,
            role: "orchestrator",
          },
        });
        yield* completeTurn(yield* waitSent(a.thread.id, 2));
        yield* waitSent(a.thread.id, 3);
        expect(yield* wrapUpsTo(a.thread.id)).toBe(1);
      }),
    ),
  );

  it.effect("sends none while its own question waits on an answer", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail", title: "Mail" });
        yield* a.session.callTool("ask_question", { question: "IMAP or POP?" });
        yield* completeTurn(a.session);
        yield* settle;
        expect(yield* wrapUpsTo(a.thread.id)).toBe(0);
      }),
    ),
  );
});
