// Orchestration service: digests, their delivery and the pauses failures leave.
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationDigest, type MessageId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { IN_ERROR_DETAIL } from "./service/kit.ts";
import { Orchestration } from "./service.ts";
import {
  collectEvents,
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitReal,
  waitSent,
  waitStatus,
  withServer,
} from "./test-harness.ts";
import { inServer, sessionsOf, notifications } from "./service-kit.ts";

const HOUR = 3_600_000;

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect("folds a burst of reasons into one digest, which is a diff of what it last told", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session, workspaceId } = yield* openOrchestrator(world);
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        const b = yield* spawn(session, { feature: "billing", title: "Billing" });
        yield* completeTurn(a.session);
        yield* TestClock.adjust("40 seconds");
        yield* completeTurn(b.session);
        // The second reason restarted the window: a minute after the first, nothing has gone out.
        yield* TestClock.adjust("40 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        yield* TestClock.adjust("20 seconds");
        yield* waitSent(session.options.threadId, 2);
        yield* settle;
        expect(session.sent).toHaveLength(2);

        const first = session.sent[1]!;
        expect(first.notice).toMatchObject({ variant: "digest", generation: 2 });
        expect(first.text).toContain("'Mail trigger' finished a turn");
        expect(first.text).toContain("'Billing' finished a turn");
        expect(first.text).toContain("What changed (2)");
        yield* completeTurn(session);
        expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 2 });
        expect(Object.keys((yield* outboxOf(workspaceId)).snapshot).toSorted()).toEqual(
          [a.thread.id, b.thread.id].toSorted(),
        );

        // Only what moved since that digest is a change in the next one.
        yield* publishGit(world, a.thread, { pr: prBadge({ checks: "pending" }) });
        yield* publishGit(world, a.thread, { pr: prBadge({ checks: "passing" }) });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(session.options.threadId, 3);
        const second = session.sent[2]!;
        expect(second.notice).toMatchObject({ generation: 3 });
        expect(second.text).toContain("'Mail trigger': checks passed");
        expect(second.text).toContain("What changed (1)");
        expect(second.text).toContain("working → inReview");
        expect(second.text).not.toContain("'Billing' finished a turn");
        yield* completeTurn(session);

        // Reasons with nothing behind them open no turn at all: a PR opened and closed again
        // inside one window leaves the worker where the last digest had it.
        const runtimes = yield* ThreadRuntimes;
        yield* publishGit(world, b.thread, {});
        yield* publishGit(world, b.thread, { pr: prBadge({ number: 13 }) });
        yield* publishGit(world, b.thread, { pr: prBadge({ number: 13, state: "CLOSED" }) });
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(3);
        expect(yield* runtimes.status(session.options.threadId)).toBe("idle");
        expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 3 });
      }),
    ),
  );

  it.effect("wakes on the branch's own PR moving while the worker is bound to another", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        const bound = {
          ...a.thread,
          boundPr: { repo: "acme/shop", number: 12, monitor: false },
        };
        // The real publisher sends a thread bound elsewhere its bound badge, and keeps the
        // checkout's own PR, #13 here, in the checkout's state.
        const publishMasked = (branch: Partial<Parameters<typeof prBadge>[0] & object>) =>
          Effect.gen(function* () {
            const shown = prBadge({ state: "MERGED", checks: "passing" });
            yield* publishGit(world, bound, { pr: shown });
            const raw = world.states.get(bound.checkout.path)!;
            world.states.set(bound.checkout.path, {
              ...raw,
              pr: prBadge({ number: 13, url: "https://github.com/acme/shop/pull/13", ...branch }),
            });
            for (const observer of world.observers) yield* observer.onState(bound, raw);
            yield* settle;
          });
        yield* publishMasked({ checks: "pending" });
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        const before = session.sent.length;
        yield* completeTurn(session).pipe(Effect.ignore);
        // Only the branch's PR moves; the worker's state moves with it, so a digest goes out.
        yield* publishMasked({ state: "MERGED", checks: "passing" });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, before + 1);
        const text = session.sent.at(-1)!.text;
        expect(text.split("\n")[1]).toContain("'Mail trigger (acme/shop)'");
        expect(text).toContain("inReview → merged");
      }),
    ),
  );

  it.effect("acknowledges only the notes a digest carried, not one written while it was out", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        for (let n = 1; n <= 10; n++) yield* orchestration.addNote(workspaceId, `Note ${n}.`);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(session.options.threadId, 2);
        expect(session.sent[1]?.text).toContain("Note 10.");

        // A full queue rolls over under the digest in flight, dropping a note it carried.
        yield* orchestration.addNote(workspaceId, "Note 11.");
        expect((yield* outboxOf(workspaceId)).notes).toHaveLength(10);
        yield* completeTurn(session);
        expect((yield* outboxOf(workspaceId)).notes).toEqual(["Note 11."]);
        yield* orchestration.addNote(workspaceId, "Note 12.");
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(session.options.threadId, 3);
        expect(session.sent[2]?.text).toContain("Note 11.");
        expect(session.sent[2]?.text).toContain("Note 12.");
        expect(session.sent[2]?.text).not.toContain("Note 10.");
      }),
    ),
  );

  it.effect("carries a quiet note with the next digest without waking for it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const sent = session.sent.length;
        yield* orchestration.noteQuietly(workspaceId, "Cleaned 3 worktrees, 1.2 GB.");
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(sent);
        expect((yield* outboxOf(workspaceId)).notes).toEqual(["Cleaned 3 worktrees, 1.2 GB."]);
        yield* orchestration.addNote(workspaceId, "Memory was consolidated.");
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(session.options.threadId, sent + 1);
        expect(session.sent.at(-1)?.text).toContain("Cleaned 3 worktrees, 1.2 GB.");
        expect(session.sent.at(-1)?.text).toContain("Memory was consolidated.");
      }),
    ),
  );

  it.effect("sends a digest within three windows of its first reason, however many follow", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* publishGit(world, a.thread, {});
        yield* settle;
        // A reason every 40 seconds would keep a plain trailing window from ever closing.
        for (const state of ["OPEN", "CLOSED", "OPEN", "CLOSED", "OPEN"] as const) {
          yield* publishGit(world, a.thread, { pr: prBadge({ state }) });
          yield* settle;
          expect(session.sent).toHaveLength(1);
          yield* TestClock.adjust("40 seconds");
        }
        // 200 s after the first; the last reason's own window would run to 220 s.
        yield* waitSent(orchestrator, 2);
        const reasons = session.sent[1]!.text.split("\n")[1];
        expect(reasons).toBe(
          "Woken by: 'Mail trigger': pull request opened; pull request closed; pull request reopened",
        );
      }),
    ),
  );

  it.effect("wakes the orchestrator once when an idle worker's worktree goes missing", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* publishGit(world, a.thread, {});
        yield* settle;
        expect(session.sent).toHaveLength(1);
        // No turn ends: the worker was at rest when its folder went.
        yield* publishGit(world, a.thread, { missing: true });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 2);
        const text = session.sent[1]!.text;
        expect(text.split("\n")[1]).toBe(
          "Woken by: 'Mail trigger' lost its worktree, deleted outside Gram",
        );
        expect(text).toContain("worktree missing");
        yield* publishGit(world, a.thread, { missing: true });
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(2);
      }),
    ),
  );

  for (const wait of ["reviewMonitor", "runMonitor", "wake"] as const) {
    it.effect(`doesn't flag a deliberate ${wait} wait as an unreported stop`, () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "waiting" });
          if (wait === "wake") {
            yield* worker.session.callTool("schedule_wake", {
              inMinutes: 30,
              note: "continue later",
            });
          } else {
            const runtimes = yield* ThreadRuntimes;
            yield* runtimes.updateThread(worker.thread.id, (thread) => ({
              ...thread,
              ...(wait === "runMonitor"
                ? { runWatches: [{ repo: "acme/shop", runId: 12, since: 1 }] }
                : {
                    boundPr: { repo: "acme/shop", number: 12, monitor: false, reviewMonitor: true },
                  }),
            }));
          }
          yield* completeTurn(worker.session);
          yield* waitReal(
            "the deliberate turn end to be observed",
            outboxOf(workspaceId).pipe(
              Effect.map((outbox) => (outbox.workers[worker.thread.id]?.turnEnds ?? 0) > 0),
            ),
          );
          expect((yield* outboxOf(workspaceId)).workers[worker.thread.id]?.quiet).toBeUndefined();
          // A scheduled wait alone need not wake the parent; inspect it on the next digest.
          yield* (yield* Orchestration).addNote(workspaceId, "Inspect deliberate wait.");
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(session.options.threadId, 2);
          expect(session.sent[1]?.text).not.toContain("went quiet mid-turn");
          expect(session.sent[1]?.text).not.toContain("without reporting");
        }),
      ),
    );
  }

  it.effect("doesn't call a turn quiet when it reported, even once that digest is taken", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* a.session.callTool("report", { state: "progress", summary: "Halfway." });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 2);
        yield* completeTurn(session);
        // The turn that filed the report ends after its digest went: nothing new to say.
        yield* completeTurn(a.session);
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(2);
        // The next one ends with no word at all, which is.
        yield* session.callTool("send_message", { threadId: a.thread.id, text: "Go on." });
        yield* completeTurn(a.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 3);
        expect(session.sent[2]!.text).toContain("ended its turn without reporting");
      }),
    ),
  );

  it.effect(
    "delivers a foreground stall despite background work, then an unreported stop once it ends",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const a = yield* spawn(session, { feature: "quiet", title: "Quiet worker" });
          yield* publishGit(world, a.thread, { pr: prBadge({ checks: "pending" }) });
          yield* settle;
          const messageId = "quiet-reply" as MessageId;
          yield* a.session.emit({ type: "chunk", messageId, chunk: { type: "start", messageId } });
          yield* a.session.emit({
            type: "backgroundTasks",
            tasks: [
              {
                taskId: "background",
                kind: "subagent",
                description: "background work",
                startedAt: 0,
              },
            ],
          });
          yield* a.session.emit({
            type: "chunk",
            messageId,
            chunk: {
              type: "tool-input-available",
              toolName: "Bash",
              toolCallId: "long",
              input: { command: "long command" },
            },
          });
          yield* settle;
          expect(
            (yield* outboxOf(a.thread.workspaceId!)).workers[a.thread.id]?.background,
          ).toHaveLength(1);
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          yield* TestClock.adjust("1 minute");
          yield* waitSent(session.options.threadId, 2);
          const stalled = session.sent[1]!.notice as OrchestrationDigest;
          expect(stalled.features[0]?.workers[0]).toMatchObject({
            state: "inReview",
            quiet: { kind: "toolStalled", lastTool: "Bash" },
          });
          yield* completeTurn(session);
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          expect(session.sent).toHaveLength(2);
          yield* a.session.emit({
            type: "chunk",
            messageId,
            chunk: { type: "tool-output-available", toolCallId: "long", output: "finished" },
          });
          yield* a.session.emit({ type: "backgroundTasks", tasks: [] });
          yield* completeTurn(a.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(session.options.threadId, 3);
          expect(session.sent[2]!.text).toContain("last tool Bash");
          expect(
            (session.sent[2]!.notice as OrchestrationDigest).features[0]?.workers[0],
          ).toMatchObject({ quiet: { kind: "turnEnded" } });
        }),
      ),
  );

  it.effect("notes a worker left to archive once, on a digest that goes anyway", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session, workspaceId } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        const b = yield* spawn(session, { feature: "billing", title: "Billing" });
        yield* completeTurn(a.session);
        yield* publishGit(world, a.thread, {
          pr: prBadge({ state: "MERGED", checks: "passing" }),
        });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 2);
        // The feature's own note says to archive it; a second one would only repeat it.
        expect(session.sent[1]!.text).toContain(
          "Feature mail-trigger: every pull request is merged",
        );
        expect(session.sent[1]!.text).not.toContain("Housekeeping");
        yield* completeTurn(session);

        yield* a.session.callTool("report", { state: "done", summary: "Merged." });
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 3);
        expect(session.sent[2]!.text).toContain(
          "Housekeeping: 1 worker is merged, reported done and not archived",
        );
        yield* completeTurn(session);
        expect((yield* outboxOf(workspaceId)).tidyNoted).toEqual([`archive:${a.thread.id}`]);

        // Still true, and already said: the next digest, about another worker, leaves it out.
        yield* completeTurn(b.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 4);
        expect(session.sent[3]!.text).toContain("'Billing' finished a turn");
        expect(session.sent[3]!.text).not.toContain("Housekeeping");
        // Nor does it list the merged worker again, which it has read and which hasn't moved.
        expect(session.sent[3]!.text).toContain(
          "Left out: 1 finished worker with nothing new since your last digest (mail-trigger).",
        );
        expect(session.sent[3]!.text).not.toContain(`"Mail trigger" [thread ${a.thread.id}]`);
        expect(session.sent[3]!.notice).toMatchObject({ quiet: [a.thread.id] });
        yield* completeTurn(session);

        // An interface is quoted once; a new material report with the same contract
        // says it is unchanged. Repeating a report itself is not a new digest.
        const contract = "POST /billing/charge → Receipt";
        for (const [n, summary, expected] of [
          [5, "Routes up.", `interface:\n${contract}`],
          [6, "Route tests passed.", "interface: unchanged since you last read it"],
        ] as const) {
          yield* b.session.callTool("report", {
            state: "progress",
            summary,
            interface: contract,
          });
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(orchestrator, n);
          expect(session.sent[n - 1]!.text).toContain(expected);
          yield* completeTurn(session);
        }

        const accepted = yield* outboxOf(workspaceId);
        yield* b.session.callTool("report", {
          state: "progress",
          summary: "Route tests passed.",
          interface: contract,
        });
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(6);
        expect(yield* outboxOf(workspaceId)).toMatchObject({
          generation: accepted.generation,
          ackedReportSeq: accepted.ackedReportSeq,
          interfacesRead: accepted.interfacesRead,
        });

        // A later report that leaves the interface out is the ledger's, and the contract stands.
        yield* b.session.callTool("report", { state: "progress", summary: "Tests next." });
        const orchestration = yield* Orchestration;
        const row = (yield* orchestration.ledger(workspaceId)).features
          .flatMap((feature) => feature.workers)
          .find((worker) => worker.threadId === b.thread.id);
        expect(row?.lastReport).toMatchObject({ state: "progress", summary: "Tests next." });
        expect(row?.lastReport).not.toHaveProperty("interface");
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(orchestrator, 7);
        yield* completeTurn(session);
        expect((yield* outboxOf(workspaceId)).snapshot[b.thread.id]?.interface).toBe(contract);
      }),
    ),
  );

  it.effect(
    "keeps duplicate reports quiet while delivering new evidence and acknowledging only its accepted batch",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          const orchestrator = session.options.threadId;
          const a = yield* spawn(session, { feature: "release", title: "Publisher" });
          yield* publishGit(world, a.thread, {
            pr: prBadge({ state: "MERGED", checks: "passing" }),
          });
          const longContract = "artifact contract ".repeat(40);
          const shortContract = "GET /release → SignedArtifact";
          const original = {
            state: "done",
            summary: "Version merged; artifact build verified.",
            interface: longContract,
          } as const;
          yield* a.session.callTool("report", original);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(orchestrator, 2);
          expect(session.sent[1]!.notice).toMatchObject({
            reports: [{ ...original, threadId: a.thread.id }],
          });
          expect(session.sent[1]!.text).toContain(
            "full worker-authored evidence: get_thread or list_workers detail",
          );
          expect((yield* outboxOf(workspaceId)).ackedReportSeq).toBe(0);
          expect(
            (yield* outboxOf(workspaceId)).inFlight?.interfacesRead?.[a.thread.id],
          ).toBeUndefined();
          yield* completeTurn(session);
          const accepted = yield* outboxOf(workspaceId);
          expect(accepted.ackedReportSeq).toBe(1);
          expect(accepted.interfacesRead?.[a.thread.id]).toBeUndefined();

          yield* a.session.callTool("report", original);
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          expect(session.sent).toHaveLength(2);
          expect((yield* outboxOf(workspaceId)).ackedReportSeq).toBe(accepted.ackedReportSeq);
          expect((yield* outboxOf(workspaceId)).snapshot).toEqual(accepted.snapshot);

          // The merged worker must remain visible for every distinct new report.
          // Six reports exceed the text preview limit: all remain in the full model,
          // but neither the clipped first nor the omitted sixth interface is read.
          for (let n = 1; n <= 6; n++) {
            yield* a.session.callTool("report", {
              state: "done",
              summary: `Artifact verification ${n} passed.`,
              ...(n === 1
                ? { interface: longContract }
                : n === 6
                  ? { interface: shortContract }
                  : {}),
            });
          }
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(orchestrator, 3);
          const digest = session.sent[2]!.notice as OrchestrationDigest;
          expect(digest.reports.map((report) => report.summary)).toEqual(
            Array.from({ length: 6 }, (_, i) => `Artifact verification ${i + 1} passed.`),
          );
          expect(digest.reports[0]?.interface).toBe(longContract);
          expect(digest.reports[5]?.interface).toBe(shortContract);
          expect(digest.quiet ?? []).not.toContain(a.thread.id);
          expect(digest.reports.some((report) => report.interfaceUnchanged)).toBe(false);
          expect((yield* outboxOf(workspaceId)).inFlight).toMatchObject({ reportSeqUpTo: 8 });
          expect(
            (yield* outboxOf(workspaceId)).inFlight?.interfacesRead?.[a.thread.id],
          ).toBeUndefined();
          expect((yield* outboxOf(workspaceId)).ackedReportSeq).toBe(1);

          // A report arriving while this batch is in flight belongs to the next one.
          yield* a.session.callTool("report", {
            state: "done",
            summary: "Signature verified; ready to publish.",
            interface: shortContract,
          });
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).ackedReportSeq).toBe(8);
          expect((yield* outboxOf(workspaceId)).interfacesRead?.[a.thread.id]).toBeUndefined();
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(orchestrator, 4);
          const next = session.sent[3]!.notice as OrchestrationDigest;
          expect(next.reports).toMatchObject([
            { summary: "Signature verified; ready to publish.", interface: shortContract },
          ]);
          expect(next.reports).toHaveLength(1);
          expect(next.reports[0]).not.toHaveProperty("interfaceUnchanged");
          expect(next.quiet ?? []).not.toContain(a.thread.id);
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).ackedReportSeq).toBe(9);
          expect((yield* outboxOf(workspaceId)).interfacesRead?.[a.thread.id]).toBeDefined();
        }),
      ),
  );

  it.effect(
    "redelivers a failed digest under the same number, and pauses after three failures",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const fake = yield* FakeAgentControl;
          const store = yield* ThreadStore;
          const events = yield* collectEvents(["notify"]);
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          const flight = (yield* outboxOf(workspaceId)).inFlight;
          expect(flight).toMatchObject({ generation: 2 });

          // The adapter ends the turn in error before it streamed anything: not accepted.
          yield* session.emit(
            { type: "turnEnd", reason: "error" },
            { type: "status", status: "idle" },
          );
          yield* waitReal(
            "the failure to be counted",
            outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.failures === 1)),
          );
          expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 1, failures: 1 });
          expect((yield* outboxOf(workspaceId)).inFlight).toBeUndefined();
          yield* TestClock.adjust("29 seconds");
          yield* settle;
          expect(session.sent).toHaveLength(2);
          yield* TestClock.adjust("1 seconds");
          yield* waitSent(thread.id, 3);
          expect(session.sent[2]?.notice).toMatchObject({ generation: 2 });
          expect(session.sent[2]?.text).toContain("finished a turn");
          expect((yield* outboxOf(workspaceId)).inFlight?.turnId).not.toBe(flight?.turnId);

          // The interrupt watchdog ends the turn itself: a host-synthesised end is no acceptance.
          yield* fake.setInterruptBehavior("hang");
          const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
          yield* waitReal(
            "the interrupt call",
            Effect.sync(() => session.interrupts === 1),
          );
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(interrupting);
          yield* waitReal(
            "the second failure",
            outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.failures === 2)),
          );
          yield* fake.setInterruptBehavior("complete");
          yield* TestClock.adjust("2 minutes");
          const resumed = yield* waitReal(
            "the third try",
            sessionsOf(thread.id).pipe(
              Effect.map((sessions) => sessions.find((s) => s !== session && s.sent.length === 1)),
            ),
          );
          expect(resumed.sent[0]?.notice).toMatchObject({ generation: 2 });

          yield* resumed.emit(
            { type: "turnEnd", reason: "error" },
            { type: "status", status: "idle" },
          );
          yield* waitReal(
            "the pause",
            store
              .getWorkspace(workspaceId)
              .pipe(Effect.map((state) => state.paused?.reason === "deliveryFailed")),
          );
          expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 1, failures: 3 });
          expect(
            notifications(events).filter((title) => title.includes("couldn't be reached")),
          ).toHaveLength(1);
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          expect(resumed.sent).toHaveLength(1);

          // Resuming tries again, and the digest that finally lands is still number 2.
          const orchestration = yield* Orchestration;
          yield* orchestration.setPaused(workspaceId, false);
          yield* TestClock.adjust("60 seconds");
          yield* waitReal(
            "the delivery after the resume",
            Effect.sync(() => resumed.sent.length === 2),
          );
          expect(resumed.sent[1]?.notice).toMatchObject({ generation: 2 });
          yield* completeTurn(resumed);
          expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 2, failures: 0 });
        }),
      ),
  );

  it.effect("still wakes an orchestrator whose last turn failed, as the user's message would", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        const other = yield* spawn(session, { feature: "billing", title: "Billing" });
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.send(thread.id, { text: "hello" });
        yield* waitSent(thread.id, 2);
        yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
        yield* waitStatus(thread.id, "error");
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 3);
        expect(session.sent[2]?.text).toContain("finished a turn");
        expect(session.sent[2]?.notice).toMatchObject({ kind: "orchestration" });
        yield* completeTurn(session);
        expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
        expect(yield* outboxOf(workspaceId)).toMatchObject({ failures: 0 });

        // A digest waiting behind a turn that fails isn't failed with it, and goes once it settles.
        yield* runtimes.send(thread.id, { text: "again" });
        yield* waitSent(thread.id, 4);
        yield* completeTurn(other.session);
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
        yield* waitStatus(thread.id, "error");
        yield* session.emit({ type: "status", status: "idle" });
        yield* waitSent(thread.id, 5);
        expect(session.sent[4]?.text).toContain("'Billing' finished a turn");
        yield* completeTurn(session);
        expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
      }),
    ),
  );

  it.effect("the user's resume of an in-error pause lets send_message through, and holds", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const orchestration = yield* Orchestration;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* completeTurn(worker.session);
        yield* runtimes.send(thread.id, { text: "hello" });
        yield* waitSent(thread.id, 2);
        yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
        yield* waitStatus(thread.id, "error");
        // The pause a turn that failed leaves over.
        const at = yield* Clock.currentTimeMillis;
        yield* store.updateWorkspace(workspaceId, (current) => ({
          ...current,
          paused: {
            reason: "deliveryFailed",
            detail: IN_ERROR_DETAIL,
            at,
          },
        }));
        const send = session.callTool("send_message", {
          threadId: worker.thread.id,
          text: "Status?",
        });
        expect(yield* send.pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("paused"),
        });

        yield* orchestration.setPaused(workspaceId, false);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 3);
        expect(session.sent[2]?.text).toContain("the user resumed orchestration");
        yield* completeTurn(session);
        yield* settle;
        expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
        expect(yield* send).toMatchObject({ delivered: "sent" });
      }),
    ),
  );

  it.effect(
    "an in-error pause from a limit lifts as soon as fresh readings show another login's headroom",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const readings = yield* UsageLimitReadings;
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          // The orchestrator stopped in error on its login's limit, and its digest paused the
          // workspace: set explicitly, as backing off a limit to the end leaves it.
          const at = yield* Clock.currentTimeMillis;
          yield* store.updateThread(thread.id, (current) => ({
            ...current,
            lastError: { kind: "rateLimit", retryable: true, text: "Usage limit reached.", at },
          }));
          yield* store.updateWorkspace(workspaceId, (current) => ({
            ...current,
            paused: { reason: "deliveryFailed", detail: IN_ERROR_DETAIL, at },
          }));
          const pausedFor = store
            .getWorkspace(workspaceId)
            .pipe(Effect.map((state) => state.paused?.reason));
          const read = (utilization: number) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* readings.replaceSubscription(
                thread.model.agent,
                [
                  { status: "allowed", window: "five_hour", utilization, resetsAt: now + 5 * HOUR },
                  {
                    status: "allowed",
                    window: "seven_day",
                    utilization,
                    resetsAt: now + 168 * HOUR,
                  },
                ],
                yield* readings.current,
              );
              yield* settle;
            });

          // Still full: nothing lifts.
          yield* TestClock.adjust("1 second");
          yield* read(1);
          expect(yield* pausedFor).toBe("deliveryFailed");

          // Another login, barely used: lifted well before the next look a minute on, and the
          // orchestrator is woken.
          yield* TestClock.adjust("1 second");
          yield* read(0);
          yield* waitReal(
            "the pause lifts",
            pausedFor.pipe(Effect.map((reason) => reason === undefined)),
          );
          yield* TestClock.adjust("60 seconds");
          const reached = yield* waitSent(thread.id, 2);
          expect(reached.sent.at(-1)?.text).toContain("the orchestrator could be reached again");
          yield* completeTurn(reached);

          // The user's own pause never lifts on readings.
          yield* orchestration.setPaused(workspaceId, true);
          yield* TestClock.adjust("1 second");
          yield* read(0);
          expect(yield* pausedFor).toBe("user");
        }),
      ),
  );

  it.effect("an in-error pause lifts by itself after a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const at = yield* Clock.currentTimeMillis;
          yield* store.updateWorkspace(workspaceId, (current) => ({
            ...current,
            paused: {
              reason: "deliveryFailed",
              detail: IN_ERROR_DETAIL,
              at,
            },
          }));
          return { threadId: thread.id, workspaceId };
        }),
      );
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          yield* TestClock.adjust("1 minute");
          yield* waitReal(
            "the look lifts it",
            store
              .getWorkspace(first.workspaceId)
              .pipe(Effect.map((state) => state.paused === undefined)),
          );
          yield* TestClock.adjust("60 seconds");
          const reached = yield* waitSent(first.threadId, 1);
          expect(reached.sent[0]?.text).toContain("the orchestrator could be reached again");
          yield* completeTurn(reached);
          expect((yield* store.getWorkspace(first.workspaceId)).paused).toBeUndefined();
        }),
      );
    }),
  );

  it.effect("a pause for an agent that couldn't start lifts by itself once it can, said once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          return { threadId: thread.id, workspaceId };
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          const orchestration = yield* Orchestration;
          const events = yield* collectEvents(["notify"]);
          const pausedFor = store
            .getWorkspace(first.workspaceId)
            .pipe(Effect.map((state) => state.paused?.reason));
          yield* fake.setUnavailable("claude isn't on the PATH");
          yield* orchestration.addNote(first.workspaceId, "Memory was consolidated.");
          yield* TestClock.adjust("60 seconds");
          yield* waitReal(
            "the pause",
            pausedFor.pipe(Effect.map((reason) => reason === "deliveryFailed")),
          );
          const opened = (yield* sessionsOf(first.threadId)).length;

          // A look that finds it still can't start pauses again without saying so.
          yield* TestClock.adjust("1 minute");
          yield* waitReal(
            "the first look lifts the pause",
            pausedFor.pipe(Effect.map((reason) => reason === undefined)),
          );
          yield* TestClock.adjust("60 seconds");
          yield* waitReal(
            "the attempt fails and pauses again",
            pausedFor.pipe(Effect.map((reason) => reason === "deliveryFailed")),
          );
          expect(yield* sessionsOf(first.threadId)).toHaveLength(opened);

          yield* fake.setUnavailable(undefined);
          yield* TestClock.adjust("2 minutes");
          yield* waitReal(
            "the second look lifts it",
            pausedFor.pipe(Effect.map((reason) => reason === undefined)),
          );
          yield* TestClock.adjust("60 seconds");
          const reached = yield* waitSent(first.threadId, 1);
          expect(reached.sent[0]?.notice).toMatchObject({ kind: "orchestration" });
          expect(reached.sent[0]?.text).toContain("the orchestrator could be reached again");
          yield* completeTurn(reached);
          const said = notifications(events);
          expect(said.filter((title) => title.includes("couldn't be reached"))).toHaveLength(1);
          expect(said.filter((title) => title.startsWith("Orchestration resumed"))).toHaveLength(1);
        }),
      );
    }),
  );
});
