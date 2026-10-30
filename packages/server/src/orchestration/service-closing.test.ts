// Orchestration service: detaching, closing, reopening and parking, and unreadable outboxes.
import { describe, expect, it } from "@effect/vitest";
import {
  type ModelRef,
  type OrchestrationDigest,
  type ServerEvent,
  type TurnId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { closedThreadHandlers } from "../rpc/handlers/closed-threads.ts";
import { threadHandlers } from "../rpc/handlers/threads.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { emptyOutbox, encodeOutbox, OUTBOX_VERSION, readOutbox } from "./outbox.ts";
import { IN_ERROR_DETAIL, Orchestration, OUTBOX_UNREADABLE_DETAIL } from "./service.ts";
import {
  atAutonomy,
  collectEvents,
  completeTurn,
  makeWorld,
  offerGit,
  openOrchestrator,
  outboxOf,
  prBadge,
  publishGit,
  settle,
  spawn,
  stallGit,
  waitReal,
  waitSent,
  withServer,
} from "./test-harness.ts";
import { inServer, sessionsOf, notifications } from "./service-kit.ts";

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect(
    "detaches a worker: a plain thread again, out of the ledger, its session reloaded",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          const notWorker = yield* orchestration.detach(session.options.threadId).pipe(Effect.flip);
          expect(notWorker).toMatchObject({ _tag: "InvalidState" });

          const detached = yield* orchestration.detach(worker.thread.id);
          expect(detached.spawnedBy).toBeUndefined();
          expect(detached.workspaceId).toBeUndefined();
          expect((yield* orchestration.ledger(workspaceId)).features).toEqual([]);
          expect(yield* orchestration.isDelegated(session.options.threadId, worker.thread.id)).toBe(
            false,
          );
          const reopened = yield* waitReal(
            "the reloaded session",
            sessionsOf(worker.thread.id).pipe(Effect.map((sessions) => sessions[1])),
          );
          expect(reopened.options).toMatchObject({ audience: "plain" });
          expect(reopened.options.outwardGate).toBeUndefined();
          expect(reopened.options.instructions).toBeUndefined();
        }),
      ),
  );

  for (const action of ["closed", "detached"] as const) {
    for (const snapshotArchived of [false, true]) {
      it.effect(
        `silently ${action} an archived worker with a ${snapshotArchived ? "parked" : "live"} snapshot`,
        () =>
          inServer((world) =>
            Effect.gen(function* () {
              const orchestration = yield* Orchestration;
              const runtimes = yield* ThreadRuntimes;
              const { thread, session, workspaceId } = yield* openOrchestrator(world);
              const old = yield* spawn(session, { feature: "old", group: "old-release" });
              const live = yield* spawn(session, { feature: "live" });
              yield* completeTurn(old.session);
              yield* publishGit(world, old.thread, {
                pr: prBadge({ state: "MERGED", checks: "passing" }),
              });
              yield* TestClock.adjust("60 seconds");
              yield* waitSent(thread.id, 2);
              yield* completeTurn(session);

              yield* session.callTool("archive_thread", { threadId: old.thread.id });
              yield* session.callTool("archive_thread", { threadId: old.thread.id });
              yield* settle;
              yield* TestClock.adjust("60 seconds");
              yield* settle;
              expect(session.sent).toHaveLength(2);
              expect((yield* outboxOf(workspaceId)).snapshot[old.thread.id]?.state).toBe("merged");

              let count = 2;
              if (snapshotArchived) {
                yield* completeTurn(live.session);
                yield* TestClock.adjust("60 seconds");
                yield* waitSent(thread.id, ++count);
                yield* completeTurn(session);
                expect((yield* outboxOf(workspaceId)).snapshot[old.thread.id]?.state).toBe(
                  "archived",
                );
              }
              if (action === "closed") yield* runtimes.close(old.thread.id);
              else yield* orchestration.detach(old.thread.id);
              yield* settle;
              yield* TestClock.adjust("60 seconds");
              yield* settle;
              expect(session.sent).toHaveLength(count);
              expect(
                (yield* orchestration.ledger(workspaceId)).features.map((f) => f.feature),
              ).toEqual(["live"]);

              yield* live.session.callTool("report", { state: "done", summary: "Finished." });
              yield* TestClock.adjust("60 seconds");
              yield* waitSent(thread.id, count + 1);
              const digest = session.sent[count]!.notice as OrchestrationDigest;
              expect(digest.changes.every((change) => change.threadId !== old.thread.id)).toBe(
                true,
              );
              expect(session.sent[count]!.text).not.toContain("archived → archived");
              expect(session.sent[count]!.text).not.toContain("a worker was");
              expect(session.sent[count]!.text).toContain(
                "Archived groups: 1; query with list_workers({includeArchived: true}).",
              );
              expect(session.sent[count]!.text).not.toContain("old-release");
              expect(digest.archivedGroupCount).toBe(1);
              expect(digest.groups?.some((group) => group.group === "old-release")).toBe(false);
              expect(session.sent[count]!.text).not.toContain("Group old-release (archived)");
              yield* completeTurn(session);
              expect((yield* outboxOf(workspaceId)).snapshot[old.thread.id]).toBeUndefined();
              expect((yield* outboxOf(workspaceId)).archivedRemovals).toEqual([]);
            }),
          ),
      );
    }

    it.effect(`wakes when a live worker is ${action}, even before it reaches a snapshot`, () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { thread, session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "live" });
          if (action === "closed") yield* runtimes.close(worker.thread.id);
          else yield* orchestration.detach(worker.thread.id);
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          expect((session.sent[1]!.notice as OrchestrationDigest).reasons).toContain(
            `a worker was ${action}`,
          );
        }),
      ),
    );
  }

  it.effect("wakes for a live close after unparking a worker from an archived snapshot", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread, session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "old" });
        const other = yield* spawn(session, { feature: "live" });
        yield* completeTurn(worker.session);
        yield* session.callTool("archive_thread", { threadId: worker.thread.id, force: true });
        yield* completeTurn(other.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 2);
        yield* completeTurn(session);
        expect((yield* outboxOf(workspaceId)).snapshot[worker.thread.id]?.state).toBe("archived");
        yield* runtimes.updateThread(worker.thread.id, (t) => ({ ...t, parked: false }));
        yield* runtimes.close(worker.thread.id);
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 3);
        expect((session.sent[2]!.notice as OrchestrationDigest).reasons).toContain(
          "a worker was closed",
        );
      }),
    ),
  );

  for (const action of ["closed", "detached"] as const) {
    it.effect(
      `delivers a live ${action} after unpark and restart, and acknowledges only delivery`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const first = yield* withServer(
            world,
            Effect.gen(function* () {
              const orchestration = yield* Orchestration;
              const runtimes = yield* ThreadRuntimes;
              const { thread, session, workspaceId } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "old" });
              const other = yield* spawn(session, { feature: "live" });
              yield* completeTurn(worker.session);
              yield* session.callTool("archive_thread", {
                threadId: worker.thread.id,
                force: true,
              });
              yield* completeTurn(other.session);
              yield* TestClock.adjust("60 seconds");
              yield* waitSent(thread.id, 2);
              yield* completeTurn(session);
              expect((yield* outboxOf(workspaceId)).snapshot[worker.thread.id]?.state).toBe(
                "archived",
              );
              yield* runtimes.updateThread(worker.thread.id, (t) => ({ ...t, parked: false }));
              if (action === "closed") yield* runtimes.close(worker.thread.id);
              else yield* orchestration.detach(worker.thread.id);
              yield* settle;
              const pending = (yield* outboxOf(workspaceId)).liveRemovals;
              expect(pending).toMatchObject([{ threadId: worker.thread.id, action }]);
              expect(session.sent).toHaveLength(2);
              return { threadId: thread.id, workspaceId, workerId: worker.thread.id, pending };
            }),
          );
          yield* withServer(
            world,
            Effect.gen(function* () {
              yield* settle;
              yield* TestClock.adjust("60 seconds");
              const session = yield* waitSent(first.threadId, 1);
              expect(session.sent[0]!.text).toContain(
                `Worker [thread ${first.workerId}] was ${action} while live`,
              );
              expect((yield* outboxOf(first.workspaceId)).liveRemovals).toEqual(first.pending);
              const generation = (yield* outboxOf(first.workspaceId)).generation;
              yield* session.emit(
                { type: "turnEnd", reason: "error" },
                { type: "status", status: "idle" },
              );
              yield* waitReal(
                "the failed delivery",
                outboxOf(first.workspaceId).pipe(Effect.map((outbox) => outbox.failures === 1)),
              );
              expect((yield* outboxOf(first.workspaceId)).liveRemovals).toEqual(first.pending);
              expect((yield* outboxOf(first.workspaceId)).generation).toBe(generation);
              yield* TestClock.adjust("30 seconds");
              yield* waitSent(first.threadId, 2);
              expect(session.sent[1]!.text).toContain(
                `Worker [thread ${first.workerId}] was ${action} while live`,
              );
              yield* completeTurn(session);
              expect((yield* outboxOf(first.workspaceId)).liveRemovals).toEqual([]);
              yield* TestClock.adjust("60 seconds");
              yield* settle;
              expect(session.sent).toHaveLength(2);
            }),
          );
        }),
    );
  }

  it.effect(
    "a live removal filed during an in-flight digest survives that digest's acknowledgment",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const a = yield* spawn(session, { feature: "a" });
          const b = yield* spawn(session, { feature: "b" });
          yield* orchestration.detach(a.thread.id);
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          const taken = (yield* outboxOf(workspaceId)).liveRemovals?.[0];
          yield* orchestration.detach(b.thread.id);
          yield* settle;
          expect((yield* outboxOf(workspaceId)).liveRemovals).toHaveLength(2);
          yield* completeTurn(session);
          const remaining = (yield* outboxOf(workspaceId)).liveRemovals;
          expect(remaining).toMatchObject([{ threadId: b.thread.id }]);
          expect(remaining?.[0]?.id).not.toBe(taken?.id);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 3);
          expect(session.sent[2]!.text).toContain(
            `Worker [thread ${b.thread.id}] was detached while live`,
          );
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).liveRemovals).toEqual([]);
        }),
      ),
  );

  it.effect(
    "keeps an archived close silent across restart without acknowledging an in-flight digest",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { thread, session, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "old" });
            yield* completeTurn(worker.session);
            yield* publishGit(world, worker.thread, {
              pr: prBadge({ state: "MERGED", checks: "passing" }),
            });
            yield* TestClock.adjust("60 seconds");
            yield* waitSent(thread.id, 2);
            yield* completeTurn(session);
            const before = yield* outboxOf(workspaceId);
            const flight = {
              generation: before.generation + 1,
              turnId: "undelivered" as TurnId,
              reportSeqUpTo: before.ackedReportSeq + 1,
              nextSnapshot: before.snapshot,
              notesUpTo: 0,
              claimedAt: 0,
            };
            yield* store.putOutbox(workspaceId, encodeOutbox({ ...before, inFlight: flight }));
            yield* session.callTool("archive_thread", { threadId: worker.thread.id });
            // No settle between park and close: the signal queue must preserve that ordering.
            yield* runtimes.close(worker.thread.id);
            yield* settle;
            const after = yield* outboxOf(workspaceId);
            expect(after.archivedRemovals).toEqual([worker.thread.id]);
            // Gone from the board with its thread, archived or not.
            const orchestration = yield* Orchestration;
            expect((yield* orchestration.ledger(workspaceId)).features).toEqual([]);
            expect(after.inFlight).toEqual(flight);
            expect(after.generation).toBe(before.generation);
            expect(after.ackedReportSeq).toBe(before.ackedReportSeq);
            expect(after.snapshot).toEqual(before.snapshot);
            return { threadId: thread.id, workspaceId };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const fake = yield* FakeAgentControl;
            yield* settle;
            yield* TestClock.adjust("60 seconds");
            yield* settle;
            expect(
              fake.sessions
                .filter((s) => s.options.threadId === first.threadId)
                .flatMap((s) => s.sent),
            ).toEqual([]);
            expect((yield* outboxOf(first.workspaceId)).inFlight).toBeUndefined();
          }),
        );
      }),
  );

  it.effect(
    "closing the orchestrator frees the slot and republishes its workers as plain threads",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const { session, thread, workspaceId, project } = yield* openOrchestrator(world);
          // At full, so a Codex worker needs no gateway profile to ask before a push.
          yield* atAutonomy(thread, "full");
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          yield* TestClock.adjust("30 seconds");
          const events = yield* collectEvents(["thread.upsert", "workspaces.changed"]);

          yield* runtimes.close(thread.id);
          const upsert = yield* waitReal(
            "the worker to be republished",
            Effect.sync(() =>
              events.find(
                (event): event is Extract<ServerEvent, { type: "thread.upsert" }> =>
                  event.type === "thread.upsert" && event.thread.id === worker.thread.id,
              ),
            ),
          );
          expect(upsert.thread.spawnedBy).toBeUndefined();
          expect(events.some((event) => event.type === "workspaces.changed")).toBe(true);
          expect(
            (yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId,
          ).toBeUndefined();
          const reopened = yield* waitReal(
            "the worker's reloaded session",
            sessionsOf(worker.thread.id).pipe(Effect.map((sessions) => sessions[1])),
          );
          expect(reopened.options).toMatchObject({ audience: "plain" });
          // The window its turn end opened has nobody left to wake.
          yield* TestClock.adjust("60 seconds");
          yield* settle;

          // ⌘⇧T brings it back as the orchestrator, in its slot, with its worker linked again.
          const closedHandlers = yield* closedThreadHandlers;
          const back = yield* closedHandlers["threads.closed.reopen"]();
          expect(back?.membership).toBe("restored");
          expect(back?.thread).toMatchObject({
            id: thread.id,
            role: "orchestrator",
            workspaceId,
          });
          expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
            thread.id,
          );
          expect((yield* store.getThread(worker.thread.id)).spawnedBy).toEqual({
            threadId: thread.id,
            feature: "mail-trigger",
          });
          expect(yield* runtimes.audienceOf(thread.id)).toBe("orchestrator");
          expect((yield* orchestration.ledger(workspaceId)).features).toMatchObject([
            { feature: "mail-trigger", workers: [{ threadId: worker.thread.id }] },
          ]);
          expect((yield* outboxOf(workspaceId)).notes.at(-1)).toContain(
            `“${worker.thread.title}” [thread ${worker.thread.id}]`,
          );
          yield* waitReal(
            "the worker's session reloaded as a worker's",
            sessionsOf(worker.thread.id).pipe(
              Effect.map((sessions) =>
                sessions.at(-1)?.options.audience === "worker" ? true : undefined,
              ),
            ),
          );

          // Closed again and replaced by `open`, which starts from a boot digest and doesn't adopt
          // the old one's workers, the old one comes back as a plain thread in the workspace.
          yield* runtimes.close(thread.id);
          const next = yield* orchestration.open({ projectId: project.id });
          expect(next.id).not.toBe(thread.id);
          const booted = yield* waitSent(next.id, 1);
          expect(booted.sent[0]?.notice).toMatchObject({ variant: "boot", generation: 2 });
          expect(booted.sent[0]?.text).toContain("Ledger: no workers yet.");
          const displaced = yield* closedHandlers["threads.closed.reopen"]();
          expect(displaced?.membership).toBe("slotTaken");
          expect(displaced?.thread?.role).toBeUndefined();
          expect(displaced?.thread?.workspaceId).toBe(workspaceId);
          expect(yield* runtimes.audienceOf(thread.id)).toBe("plain");
          expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
            next.id,
          );
          expect((yield* store.getThread(worker.thread.id)).spawnedBy).toBeUndefined();
        }),
      ),
  );

  it.effect(
    "a worker closed with its worktree comes back as a worker, its conversation kept, to restore",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          yield* completeTurn(session);
          const messages = (yield* store.listMessages(worker.thread.id)).map((m) => m.id);
          expect(messages.length).toBeGreaterThan(0);
          const path = worker.thread.checkout.path;
          // "Clean up worktree…" on the board: the close removes the worktree, keeping the branch.
          yield* runtimes.close(worker.thread.id, { removeWorktree: { force: true } });
          expect(fs.existsSync(path)).toBe(false);
          const opened = (yield* sessionsOf(worker.thread.id)).length;

          const closedHandlers = yield* closedThreadHandlers;
          const back = yield* closedHandlers["threads.closed.reopen"]();
          expect(back?.closed.problem).toBe("folderMissing");
          expect(back?.membership).toBe("restored");
          expect(back?.thread).toMatchObject({
            id: worker.thread.id,
            workspaceId,
            spawnedBy: worker.thread.spawnedBy,
            checkout: worker.thread.checkout,
          });
          expect((yield* store.listMessages(worker.thread.id)).map((m) => m.id)).toEqual(messages);
          // No agent is started in a folder that's gone, and the entry isn't lost.
          expect(yield* sessionsOf(worker.thread.id)).toHaveLength(opened);
          expect((yield* store.listClosed).map((e) => e.thread.id)).not.toContain(worker.thread.id);
          expect((yield* orchestration.ledger(workspaceId)).features).toMatchObject([
            { feature: "mail-trigger", workers: [{ threadId: worker.thread.id }] },
          ]);
          expect((yield* outboxOf(workspaceId)).notes.at(-1)).toContain(
            `It is your worker on mail-trigger again.`,
          );

          // The folder-missing flow's "Restore worktree" brings it back from its branch.
          const handlers = yield* threadHandlers;
          const restored = yield* handlers["thread.restoreWorktree"]({
            threadId: worker.thread.id,
          });
          expect(restored).toMatchObject({ _tag: "restored", path });
          expect(fs.existsSync(path)).toBe(true);
        }),
      ),
  );

  it.effect(
    "a reopen asks admission of the orchestrator as its slot's holder, and relinks its workers",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          // At full there is no gate, so a direct Codex model is admitted as the slot's holder.
          yield* atAutonomy(thread, "full");
          const kept = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(kept.session);
          const direct = { agent: "codex", model: "gpt-5.5" } as ModelRef;
          yield* runtimes.updateThread(thread.id, (t) => ({ ...t, model: direct }));
          yield* runtimes.close(thread.id);

          const closedHandlers = yield* closedThreadHandlers;
          const back = yield* closedHandlers["threads.closed.reopen"]();
          expect(back?.membership).toBe("restored");
          expect(back?.thread).toMatchObject({ role: "orchestrator", model: direct });
          expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
            thread.id,
          );
          expect((yield* store.getThread(kept.thread.id)).spawnedBy?.threadId).toBe(thread.id);
        }),
      ),
  );

  it.effect(
    "a worker reopened after its orchestrator closed stays in the workspace, unlinked",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          yield* runtimes.close(worker.thread.id);
          yield* runtimes.close(thread.id);
          // The orchestrator, closed last, is newest on the list; the worker is reopened without it.
          yield* (yield* ThreadStore).forgetClosed(thread.id);
          const closedHandlers = yield* closedThreadHandlers;
          const lone = yield* closedHandlers["threads.closed.reopen"]();
          expect(lone?.membership).toBe("orchestratorGone");
          expect(lone?.thread?.workspaceId).toBe(workspaceId);
          expect(lone?.thread?.spawnedBy).toBeUndefined();
          expect(yield* runtimes.audienceOf(worker.thread.id)).toBe("plain");
        }),
      ),
  );

  it.effect("a user's pause stops waking and spawning until they resume", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const events = yield* collectEvents(["notify"]);
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        const state = yield* orchestration.setPaused(workspaceId, true);
        expect(state.paused?.reason).toBe("user");
        expect((yield* orchestration.ledger(workspaceId)).paused?.reason).toBe("user");
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        // Their own doing: no needs-you notification for it.
        expect(notifications(events)).toEqual([]);

        expect((yield* orchestration.setPaused(workspaceId, false)).paused).toBeUndefined();
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(session.options.threadId, 2);
        expect(session.sent[1]?.text).toContain("What changed (1)");
      }),
    ),
  );

  it.effect("an outbox found unreadable while running sends no digest from the empty one", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* completeTurn(worker.session);
        const newer = JSON.stringify({ version: OUTBOX_VERSION + 1, generation: 9, wakes: {} });
        yield* store.putOutbox(workspaceId, newer);
        // The window's digest surveys first, which sets the row aside before its pause lands.
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        expect((yield* store.getWorkspace(workspaceId)).paused?.detail).toBe(
          OUTBOX_UNREADABLE_DETAIL,
        );
        expect(readOutbox(yield* store.getOutbox(workspaceId))).toMatchObject({
          _tag: "read",
          setAside: newer,
        });
      }),
    ),
  );

  it.effect("an outbox it can't read is set aside at boot, paused until the user resumes", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const newer = JSON.stringify({ version: OUTBOX_VERSION + 1, generation: 9, wakes: {} });
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          // As a newer build would leave it for this one to boot on, under a pause that recovery
          // would lift by itself.
          yield* store.putOutbox(workspaceId, newer);
          const at = yield* Clock.currentTimeMillis;
          yield* store.updateWorkspace(workspaceId, (current) => ({
            ...current,
            paused: { reason: "deliveryFailed", detail: IN_ERROR_DETAIL, at },
          }));
          return { threadId: thread.id, workspaceId };
        }),
      );
      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          yield* settle;
          expect((yield* store.getWorkspace(first.workspaceId)).paused).toMatchObject({
            reason: "deliveryFailed",
            detail: OUTBOX_UNREADABLE_DETAIL,
          });
          // An empty outbox in its place, which writes for real, with the row kept whole.
          const kept = readOutbox(yield* store.getOutbox(first.workspaceId));
          expect(kept).toMatchObject({ _tag: "read", setAside: newer, state: emptyOutbox });
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          expect(fake.sessions).toEqual([]);
          expect((yield* store.getWorkspace(first.workspaceId)).paused?.detail).toBe(
            OUTBOX_UNREADABLE_DETAIL,
          );

          yield* orchestration.setPaused(first.workspaceId, false);
          const resumed = readOutbox(yield* store.getOutbox(first.workspaceId));
          expect(resumed).toMatchObject({ _tag: "read", version: OUTBOX_VERSION });
          expect(resumed._tag === "read" && resumed.setAside).toBeUndefined();
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(first.threadId, 1);
          expect((yield* store.getWorkspace(first.workspaceId)).paused).toBeUndefined();
        }),
      );
    }),
  );

  it.effect("parking the orchestrator pauses its workspace until it is unparked", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const events = yield* collectEvents(["notify"]);
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* waitReal(
          "the park's pause",
          store
            .getWorkspace(workspaceId)
            .pipe(Effect.map((state) => state.paused?.reason === "parked")),
        );
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        expect(notifications(events)).toEqual([]);

        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        yield* waitReal(
          "the resume",
          store.getWorkspace(workspaceId).pipe(Effect.map((state) => state.paused === undefined)),
        );
        yield* TestClock.adjust("60 seconds");
        // Parking closed the idle session, so the digest may open another.
        const fake = yield* FakeAgentControl;
        const digest = yield* waitReal(
          "the digest the park held back",
          Effect.sync(() =>
            fake.sessions
              .filter((each) => each.options.threadId === thread.id)
              .flatMap((each) => each.sent)
              .find((sent) => sent.text.includes("the user resumed orchestration")),
          ),
        );
        expect(digest.text).toContain("What changed (1)");

        // Resuming a parked workspace from the board or Settings unparks its orchestrator too.
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* waitReal(
          "the second park's pause",
          store
            .getWorkspace(workspaceId)
            .pipe(Effect.map((state) => state.paused?.reason === "parked")),
        );
        yield* orchestration.setPaused(workspaceId, false);
        expect((yield* store.getThread(thread.id)).parked).toBe(false);
        yield* settle;
        expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();

        // Parking gives up a handoff under way, and none starts while parked.
        yield* orchestration.handoff(workspaceId, "user");
        expect((yield* outboxOf(workspaceId)).handoff).toBeDefined();
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* waitReal(
          "the handoff to be given up",
          outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.handoff === undefined)),
        );
        const refused = yield* orchestration.handoff(workspaceId, "user").pipe(Effect.flip);
        expect(refused.message).toContain("is parked");
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        yield* settle;

        // A pause of the user's own outlasts a park, and resuming it unparks the orchestrator too.
        yield* orchestration.setPaused(workspaceId, true);
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* settle;
        expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");
        yield* orchestration.setPaused(workspaceId, false);
        expect((yield* store.getThread(thread.id)).parked).toBe(false);

        // A pause of the user's own outlasts a park and an unpark.
        yield* orchestration.setPaused(workspaceId, true);
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        yield* settle;
        expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");

        // Closing a parked orchestrator ends its park, so the next one opens unpaused.
        yield* orchestration.setPaused(workspaceId, false);
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* waitReal(
          "the last park's pause",
          store
            .getWorkspace(workspaceId)
            .pipe(Effect.map((state) => state.paused?.reason === "parked")),
        );
        yield* runtimes.close(thread.id);
        yield* waitReal(
          "the park to end with its thread",
          store.getWorkspace(workspaceId).pipe(Effect.map((state) => state.paused === undefined)),
        );
        const next = yield* orchestration.open({ workspaceId });
        expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
        expect((yield* waitSent(next.id, 1)).sent[0]?.notice).toMatchObject({ variant: "boot" });
      }),
    ),
  );

  it.effect("a park and an unpark queued behind a busy consumer still give up the handoff", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const runtimes = yield* ThreadRuntimes;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const busy = yield* spawn(session, { feature: "billing" });
        yield* orchestration.handoff(workspaceId, "user");
        expect((yield* outboxOf(workspaceId)).handoff).toBeDefined();
        yield* settle;

        const release = yield* stallGit(world, busy.thread);
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        yield* release;
        yield* waitReal(
          "the handoff to be given up",
          outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.handoff === undefined)),
        );
      }),
    ),
  );

  it.effect("a never-seen worker's pending then passing checks, queued together, still wake", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        const { session } = yield* openOrchestrator(world);
        const busy = yield* spawn(session, { feature: "billing", title: "Billing" });
        const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* settle;

        const release = yield* stallGit(world, busy.thread);
        yield* offerGit(world, worker.thread, { pr: prBadge({ checks: "pending" }) });
        yield* offerGit(world, worker.thread, { pr: prBadge({ checks: "passing" }) });
        yield* release;
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        yield* waitReal(
          "the digest that says so",
          Effect.sync(() =>
            fake.sessions
              .filter((each) => each.options.threadId === session.options.threadId)
              .flatMap((each) => each.sent)
              .some((sent) => sent.text.includes("'Mail trigger': checks passed")),
          ),
        );
      }),
    ),
  );

  it.effect("notices the orchestrator editing a workspace checkout itself, and says so", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* runtimes.send(thread.id, { text: "fix the typo" });
        yield* waitSent(thread.id, 2);
        // The baseline is two git calls on the consumer's fiber, which `settle` sees out.
        yield* settle;
        fs.writeFileSync(nodePath.join(world.repo, "tracked.txt"), "edited by the orchestrator\n");
        yield* session.completeTurn();
        yield* waitReal(
          "the drift to be recorded",
          outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.orchestratorEdits === 1)),
        );
        expect((yield* outboxOf(workspaceId)).notes).toEqual([
          "You changed 1 file in shop yourself; hand this kind of thing to a worker.",
        ]);
        expect((yield* orchestration.ledger(workspaceId)).orchestratorEdits).toBe(1);
        const audit = yield* store.listOrchestrationEvents(workspaceId, 0);
        expect(audit.map((event) => event.kind)).toContain("orchestratorEdits");

        yield* completeTurn(worker.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 3);
        expect(session.sent[2]?.text).toContain("You changed 1 file in shop yourself");
        yield* completeTurn(session);
        expect((yield* outboxOf(workspaceId)).notes).toEqual([]);
      }),
    ),
  );
});
