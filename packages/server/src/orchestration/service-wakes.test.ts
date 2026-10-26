// Orchestration service: wakes, dependencies, and holds for what the user typed.
import { describe, expect, it } from "@effect/vitest";
import {
  STUCK_AFTER_MS,
  type GramUIMessage,
  type OrchestratorLedger,
  type PrStatus,
  type MessageId,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadVisibility } from "../git/visibility.ts";
import { ThreadAssistLive } from "../helper/assist.ts";
import { CATCH_UP_SYSTEM } from "../helper/catch-up.ts";
import { STUCK_SYSTEM } from "../helper/stuck.ts";
import { assistHandlers } from "../helper/handler.ts";
import { HelperScheduler, type HelperJob, type HelperSchedulerShape } from "../helper/scheduler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { threadHandlers } from "../rpc/handlers/threads.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadWakes } from "../wakes/thread-wakes.ts";
import { orchestrationHandlers } from "./handler.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  openProject,
  outboxOf,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitReal,
  waitSent,
  waitStatus,
  watchedPr,
  withServer,
} from "./test-harness.ts";
import { inServer, texts, sessionsOf, otherBadge, baseBadge } from "./service-kit.ts";

const eight = (overrides: Partial<PrStatus>) =>
  otherBadge({ number: 8, url: "https://github.com/acme/app/pull/8", ...overrides });

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect("wakes set with schedule_wake outlive a restart and fire when due", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "codex-bump" });
          const set = (yield* worker.session.callTool("schedule_wake", {
            inMinutes: 10,
            note: "the release-age window is over: bump codex",
          })) as { readonly id: string; readonly at: string };
          yield* session.callTool("schedule_wake", {
            at: new Date(Date.parse(set.at) + 20 * 60_000).toISOString(),
            note: "look at the rollout",
          });
          const later = (yield* worker.session.callTool("schedule_wake", {
            inMinutes: 60,
            note: "never mind",
          })) as { readonly id: string };
          expect(yield* worker.session.callTool("cancel_wake", { id: later.id })).toEqual({
            cancelled: 1,
          });
          const refused = yield* worker.session
            .callTool("schedule_wake", { inMinutes: 0, note: "now" })
            .pipe(Effect.flip);
          expect(refused.message).toContain("in the future");

          const listed = (yield* session.callTool("list_workers", {})) as OrchestratorLedger;
          expect(listed.wakes).toEqual([expect.objectContaining({ note: "look at the rollout" })]);
          expect(listed.features[0]?.workers[0]?.wakes).toEqual([
            {
              id: set.id,
              at: Date.parse(set.at),
              note: "the release-age window is over: bump codex",
            },
          ]);
          return { threadId: thread.id, workspaceId, workerId: worker.thread.id };
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          expect((yield* outboxOf(first.workspaceId)).wakes).toHaveLength(2);
          // The worker's falls due after the restart.
          yield* TestClock.adjust("10 minutes");
          const woken = yield* waitSent(first.workerId, 1);
          expect(woken.sent[0]?.text).toContain("Your note: the release-age window is over");
          expect((yield* outboxOf(first.workspaceId)).wakes).toHaveLength(1);

          // The orchestrator's falls due, and the app quits before its digest goes.
          yield* TestClock.adjust("20 minutes");
          yield* settle;
          expect((yield* outboxOf(first.workspaceId)).wakes).toBeUndefined();
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          const digest = yield* waitReal(
            "the orchestrator's wake in a digest",
            sessionsOf(first.threadId).pipe(
              Effect.map((sessions) =>
                sessions
                  .flatMap((session) => session.sent)
                  .find((input) => input.text.includes("Your note: look at the rollout")),
              ),
            ),
          );
          expect(digest.text).toContain("Notes:");
          expect((yield* outboxOf(first.workspaceId)).dueWakes).toHaveLength(1);
          yield* completeTurn(yield* waitSent(first.threadId, 1));
          expect((yield* outboxOf(first.workspaceId)).dueWakes).toBeUndefined();
        }),
      );
    }),
  );

  it.effect(
    "a wake on another PR fires on its event, for a worker, its orchestrator and a plain thread",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const wakes = yield* ThreadWakes;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const orchestrator = session.options.threadId;
          const worker = yield* spawn(session, { feature: "stacked", title: "Stacked" });
          yield* completeTurn(worker.session);
          const other = { repo: "acme/app", number: 99 };
          world.prBadges.set("acme/app#99", otherBadge());

          const set = yield* worker.session.callTool("schedule_wake", {
            onPr: "acme/app#99",
            on: ["merged"],
            note: "rebase once it lands",
          });
          expect(set).toMatchObject({ onPr: "acme/app#99", on: ["merged"] });
          yield* session.callTool("schedule_wake", {
            onPr: "https://github.com/acme/app/pull/99",
            on: ["headChanged"],
            inMinutes: 600,
            note: "look at the new push",
          });
          // One lookup in the worker's sweeps, one in the orchestrator's; `Pr`'s cache makes them one.
          expect(world.prWatches.get(`orchestration ${workspaceId}`)).toEqual([
            { threadId: worker.thread.id, repo: "acme/app", number: 99, reviews: false },
            { threadId: orchestrator, repo: "acme/app", number: 99, reviews: false },
          ]);
          const listed = (yield* session.callTool("list_workers", {})) as OrchestratorLedger;
          expect(listed.features[0]?.workers[0]?.wakes?.[0]).toMatchObject({
            onPr: other,
            on: ["merged"],
          });

          // A push fires the orchestrator's, into its digest, and leaves the worker's waiting.
          yield* watchedPr(world, other, otherBadge({ headRefOid: "h2" }));
          yield* TestClock.adjust("60 seconds");
          const digest = yield* waitReal(
            "the orchestrator's wake in a digest",
            sessionsOf(orchestrator).pipe(
              Effect.map((sessions) =>
                sessions
                  .flatMap((each) => each.sent)
                  .find((input) => input.text.includes("Your note: look at the new push")),
              ),
            ),
          );
          expect(digest.text).toContain("fired: acme/app#99 got a new push (head h2).");
          expect(worker.session.sent).toHaveLength(1);
          // The worker's kept what it saw, so a restart measures its merge from the new head.
          expect((yield* outboxOf(workspaceId)).wakes?.[0]?.seen).toMatchObject({ head: "h2" });

          yield* watchedPr(world, other, otherBadge({ state: "MERGED", headRefOid: "h2" }));
          const woken = yield* waitSent(worker.thread.id, 2);
          expect(woken.sent[1]?.text).toContain("on acme/app#99 fired: it merged.");
          expect(woken.sent[1]?.text).toContain(
            "```pr-event\npr: acme/app#99\nevent: merged\nhead: h2",
          );
          yield* completeTurn(woken);
          expect((yield* outboxOf(workspaceId)).wakes).toBeUndefined();
          expect(world.prWatches.get(`orchestration ${workspaceId}`)).toEqual([]);
          const late = yield* worker.session
            .callTool("schedule_wake", { onPr: "acme/app#99", note: "too late" })
            .pipe(Effect.flip);
          expect(late.message).toContain("merged already");

          // A plain thread's is its own, and fires the same way.
          const plain = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            title: "Watching",
            input: { text: "hello" },
          });
          const own = yield* waitSent(plain.id, 1);
          yield* completeTurn(own);
          world.prBadges.set(
            "acme/app#7",
            otherBadge({ number: 7, url: "https://github.com/acme/app/pull/7" }),
          );
          yield* own.callTool("schedule_wake", {
            onPr: "acme/app#7",
            on: ["checksSettled"],
            note: "green yet?",
          });
          expect((yield* wakes.list).wakes[0]).toMatchObject({
            onPr: { repo: "acme/app", number: 7 },
            seen: { state: "open", checks: "pending" },
          });
          expect(world.prWatches.get("threadWakes")).toHaveLength(1);
          yield* watchedPr(
            world,
            { repo: "acme/app", number: 7 },
            otherBadge({ number: 7, url: "https://github.com/acme/app/pull/7", headRefOid: "h3" }),
          );
          expect((yield* wakes.list).wakes[0]?.seen).toMatchObject({
            head: "h3",
            checks: "pending",
          });
          yield* watchedPr(
            world,
            { repo: "acme/app", number: 7 },
            otherBadge({ number: 7, url: "https://github.com/acme/app/pull/7", checks: "passing" }),
          );
          const told = yield* waitSent(plain.id, 2);
          expect(told.sent[1]?.text).toContain("had its checks settle: passing");
          yield* settle;
          expect((yield* wakes.list).wakes).toEqual([]);
          expect(world.prWatches.get("threadWakes")).toEqual([]);

          // A worker's checks wake fires while the workspace is paused: the event is kept, so a
          // rerun that takes the checks back to pending before the resume doesn't undo it.
          const orchestration = yield* Orchestration;
          world.prBadges.set(
            "acme/app#8",
            otherBadge({ number: 8, url: "https://github.com/acme/app/pull/8" }),
          );
          yield* worker.session.callTool("schedule_wake", {
            onPr: "acme/app#8",
            on: ["checksSettled"],
            note: "green yet?",
          });
          yield* orchestration.setPaused(workspaceId, true);
          yield* watchedPr(world, { repo: "acme/app", number: 8 }, eight({ checks: "passing" }));
          yield* settle;
          expect((yield* outboxOf(workspaceId)).wakes?.[0]?.fired).toMatchObject({
            event: "checksSettled",
          });
          yield* watchedPr(world, { repo: "acme/app", number: 8 }, eight({ checks: "pending" }));
          yield* settle;
          const before = woken.sent.length;
          yield* orchestration.setPaused(workspaceId, false);
          const resumed = yield* waitSent(worker.thread.id, before + 1);
          expect(resumed.sent.at(-1)?.text).toContain("had its checks settle: passing");
        }),
      ),
  );

  it.effect("a declared dependency wakes its PR's thread, orders the merge and flags a drag", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const orchestrator = session.options.threadId;
        const worker = yield* spawn(session, { feature: "stacked", title: "Stacked" });
        const base = { repo: "acme/app", number: 100 };
        world.prBadges.set("acme/app#100", baseBadge());

        const unbound = yield* worker.session
          .callTool("depends_on", { pr: "acme/app#100" })
          .pipe(Effect.flip);
        expect(unbound.message).toContain("No pull request is bound");
        yield* runtimes.updateThread(worker.thread.id, (t) => ({
          ...t,
          boundPr: { repo: "acme/shop", number: 12, monitor: false },
        }));
        // Its PR conflicts with its base before anything depends on it: no git state moves later.
        yield* publishGit(world, yield* store.getThread(worker.thread.id), {
          pr: prBadge({ mergeState: "DIRTY" }),
        });
        expect(
          yield* session.callTool("depends_on", { threadId: worker.thread.id, pr: "acme/app#100" }),
        ).toEqual({ pr: "acme/shop#12", dependsOn: ["acme/app#100"] });
        expect(world.prWatches.get("dependencies")).toEqual([
          { threadId: worker.thread.id, repo: "acme/app", number: 100, reviews: true },
        ]);
        const kept = yield* worker.session
          .callTool("depends_on", { pr: "acme/app#100", remove: true })
          .pipe(Effect.flip);
        expect(kept.message).toContain("only it can change that");
        const looser = yield* worker.session
          .callTool("depends_on", { pr: "acme/app#100", mergeAfter: false })
          .pipe(Effect.flip);
        expect(looser.message).toContain("only it can change that");
        // Nor can the worker drop it by unbinding its PR, or binding another in its place.
        const unbind = yield* worker.session.callTool("pr_unbind", {}).pipe(Effect.flip);
        expect(unbind.message).toContain("only it can drop that");
        expect((yield* store.getThread(worker.thread.id)).boundPr?.dependsOn).toEqual([
          expect.objectContaining({
            ...base,
            setBy: "orchestrator",
            seen: { state: "open", head: "d1" },
          }),
        ]);

        // Conflicting with its base for half an hour, it drags on, and the orchestrator hears it.
        yield* settle;
        const ledger = yield* orchestration.ledger(workspaceId);
        expect(ledger.features[0]?.workers[0]?.pr).toMatchObject({
          conflictedMin: 0,
          dependsOn: [{ ...base, state: "open", headRef: "feat/base", setBy: "orchestrator" }],
        });
        yield* TestClock.adjust("30 minutes");
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        const digest = yield* waitReal(
          "the drag in a digest",
          sessionsOf(orchestrator).pipe(
            Effect.map((sessions) =>
              sessions
                .flatMap((each) => each.sent)
                .find((input) => input.text.includes("drags on")),
            ),
          ),
        );
        expect(digest.text).toContain("acme/app#100, which its PR depends on, drags on");
        expect(digest.text).toContain(
          "PR acme/shop#12 (checks pending, merge DIRTY) ← acme/app#100",
        );
        expect(digest.text).toContain("consider stacking #12 on feat/base");

        // A push to it and then its merge each wake the worker, which needn't have set a wake; a
        // pause holds the push until the resume.
        yield* completeTurn(worker.session);
        yield* orchestration.setPaused(workspaceId, true);
        yield* watchedPr(world, base, baseBadge({ headRefOid: "d2" }));
        yield* settle;
        expect(worker.session.sent).toHaveLength(1);
        yield* orchestration.setPaused(workspaceId, false);
        const pushed = yield* waitSent(worker.thread.id, 2);
        expect(pushed.sent[1]?.text).toContain(
          "acme/app#100, which your acme/shop#12 depends on, got a new push.",
        );
        yield* completeTurn(pushed);
        yield* watchedPr(world, base, baseBadge({ headRefOid: "d2", state: "MERGED" }));
        const merged = yield* waitSent(worker.thread.id, 3);
        expect(merged.sent[2]?.text).toContain("depends on, merged.");
        yield* settle;
        expect((yield* store.getThread(worker.thread.id)).boundPr?.dependsOn?.[0]?.seen).toEqual({
          state: "merged",
          head: "d2",
        });
        expect(world.prWatches.get("dependencies")).toEqual([]);
        const done = yield* session
          .callTool("depends_on", { threadId: worker.thread.id, pr: "acme/app#101" })
          .pipe(Effect.flip);
        expect(done.message).toContain("GitHub has no pull request acme/app#101");
      }),
    ),
  );

  it.effect(
    "a plain thread's wakes are its own: capped, kept over a restart, held while parked, gone with the thread",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const wakes = yield* ThreadWakes;
            yield* openProject(world);
            const open = (title: string) =>
              Effect.gen(function* () {
                const thread = yield* runtimes.create({
                  projectRoot: world.repo,
                  checkout: { kind: "main", path: world.repo },
                  title,
                  input: { text: "hello" },
                });
                const session = yield* waitSent(thread.id, 1);
                yield* completeTurn(session);
                return { thread, session };
              });
            const { thread, session } = yield* open("Canary");
            const set = (yield* session.callTool("schedule_wake", {
              inMinutes: 10,
              note: "check the canary",
            })) as { readonly id: string; readonly at: string };
            const extra = [];
            for (let i = 0; i < 4; i++) {
              extra.push(
                (yield* session.callTool("schedule_wake", {
                  inMinutes: 60 + i,
                  note: `n${i}`,
                })) as {
                  readonly id: string;
                },
              );
            }
            const capped = yield* session
              .callTool("schedule_wake", { inMinutes: 5, note: "one too many" })
              .pipe(Effect.flip);
            expect(capped.message).toContain("5 wakes pending");
            const tooFar = yield* session
              .callTool("schedule_wake", { inMinutes: 8 * 24 * 60, note: "next week" })
              .pipe(Effect.flip);
            expect(tooFar.message).toContain("at most 7 days");
            for (const { id } of extra) {
              expect(yield* session.callTool("cancel_wake", { id })).toEqual({ cancelled: 1 });
            }
            const unknown = yield* session
              .callTool("cancel_wake", { id: "nope" })
              .pipe(Effect.flip);
            expect(unknown.message).toContain("No pending wake");

            // A closed thread's wakes go with it.
            const other = yield* open("Closed soon");
            yield* other.session.callTool("schedule_wake", { inMinutes: 5, note: "gone" });
            expect((yield* wakes.list).wakes).toHaveLength(2);
            yield* runtimes.close(other.thread.id);
            expect((yield* wakes.list).wakes).toEqual([
              expect.objectContaining({
                id: set.id,
                threadId: thread.id,
                note: "check the canary",
              }),
            ]);
            const overdue = yield* open("Overdue");
            yield* overdue.session.callTool("schedule_wake", {
              inMinutes: 2,
              note: "due while the app was down",
            });
            return {
              threadId: thread.id,
              wakeId: set.id,
              wakeAt: Date.parse(set.at),
              overdueId: overdue.thread.id,
            };
          }),
        );
        // The app is down when the second falls due.
        yield* TestClock.adjust("5 minutes");

        yield* withServer(
          world,
          Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const wakes = yield* ThreadWakes;
            const fake = yield* FakeAgentControl;
            // It fires at start, into a session opened with the wake tools bound.
            const late = yield* waitSent(first.overdueId, 1);
            expect(late.sent[0]?.text).toContain("Your note: due while the app was down");
            expect(
              yield* late.callTool("schedule_wake", { inMinutes: 30, note: "and again" }),
            ).toMatchObject({ id: expect.any(String) });
            expect(yield* late.callTool("cancel_wake", {})).toEqual({ cancelled: 1 });
            yield* settle;
            yield* runtimes.updateThread(first.threadId, (t) => ({ ...t, parked: true }));
            yield* TestClock.adjust("12 minutes");
            yield* settle;
            expect(fake.sessions.filter((s) => s.options.threadId === first.threadId)).toEqual([]);
            expect((yield* wakes.list).wakes.map((wake) => wake.id)).toEqual([first.wakeId]);

            yield* runtimes.updateThread(first.threadId, (t) => ({ ...t, parked: false }));
            yield* TestClock.adjust("1 minute");
            const woken = yield* waitSent(first.threadId, 1);
            expect(woken.sent[0]?.text).toContain("Your note: check the canary");
            yield* settle;
            expect((yield* wakes.list).wakes).toEqual([]);
          }),
        );
      }),
  );

  it.effect("keeps a wake its worker couldn't take yet, and delivers it once it can", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "transient-reservation" });
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("16 minutes");
        yield* settle;
        yield* waitStatus(worker.thread.id, "cold");
        const wake = yield* orchestration.scheduleWake(worker.thread.id, {
          inMinutes: 1,
          note: "continue when the build settles",
        });
        // Its worktree being cleaned up, say: the reservation turns every send away meanwhile.
        const reserved = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reservation = yield* runtimes
          .whileAtRest(
            worker.thread.id,
            Deferred.succeed(reserved, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(reserved);
        yield* TestClock.adjust("1 minute");
        yield* settle;
        const pending = (yield* outboxOf(workspaceId)).wakes ?? [];
        expect(pending.map((each) => each.id)).toEqual([wake.id]);
        // Kept past its time it retries by itself.
        yield* TestClock.adjust("6 minutes");
        yield* settle;
        expect(yield* store.listQueue(worker.thread.id)).toHaveLength(0);
        expect(worker.session.sent).toHaveLength(1);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reservation);
        yield* TestClock.adjust("1 minute");
        const woken = yield* waitSent(worker.thread.id, 1);
        expect(woken).not.toBe(worker.session);
        expect(woken.sent[0]?.text).toContain("Your note: continue when the build settles");
        yield* settle;
        expect((yield* outboxOf(workspaceId)).wakes).toBeUndefined();
      }),
    ),
  );

  it.effect("tells of a worker waiting on the user, again once it has waited ten minutes", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* worker.session.emit({
          type: "request",
          request: { kind: "question", id: "req-1" as RequestId, questions: [] },
        });
        yield* waitStatus(worker.thread.id, "needsInput");
        yield* settle;
        // Needing the user is a state change, but nothing had happened to wake anyone over yet.
        yield* TestClock.adjust("9 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        expect((yield* orchestration.ledger(workspaceId)).features[0]?.workers[0]).toMatchObject({
          state: "needsUser",
          pendingRequests: [{ kind: "question", ageMin: 9 }],
        });

        yield* TestClock.adjust("2 minutes");
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 2);
        expect(session.sent[1]?.text).toContain("'Mail trigger' has waited 10 min on the user");
        expect(session.sent[1]?.text).toContain("new, needsUser");
        expect(session.sent[1]?.text).toContain("waiting 11m on question");
      }),
    ),
  );

  it.effect(
    "holds a worker for what the user typed, not for a notice, until they hand it back",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const handlers = yield* orchestrationHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
          yield* completeTurn(worker.session);
          const held = outboxOf(workspaceId).pipe(
            Effect.map((outbox) => outbox.workers[worker.thread.id]?.userIntervened === true),
          );

          // Gram's own messages into the thread are not the user stepping in.
          yield* runtimes.sendNotice(worker.thread.id, "ci:o/r#7", { text: "CI passed on #7" });
          yield* completeTurn(worker.session);
          expect(yield* held).toBe(false);

          yield* runtimes.send(worker.thread.id, { text: "codeql is failing" });
          yield* waitReal("the hold", held);
          yield* completeTurn(worker.session);
          yield* handlers["orchestrator.releaseWorker"]({ threadId: worker.thread.id });
          expect(yield* held).toBe(false);
          expect((yield* outboxOf(workspaceId)).notes).toEqual([
            `The user handed "Mail trigger" [thread ${worker.thread.id}] back to you; you may message it again.`,
          ]);
          // Nothing is said to the worker, and a second release is a no-op.
          expect(texts(worker.session).at(-1)).toBe("codeql is failing");
          yield* handlers["orchestrator.releaseWorker"]({ threadId: worker.thread.id });
          expect((yield* outboxOf(workspaceId)).notes).toHaveLength(1);

          yield* TestClock.adjust("60 seconds");
          const digest = yield* waitReal(
            "the digest that says so",
            Effect.sync(() => texts(session).find((text) => text.includes("handed"))),
          );
          expect(digest).toContain('The user handed "Mail trigger"');
          expect(
            yield* session.callTool("send_message", {
              threadId: worker.thread.id,
              text: "Status?",
            }),
          ).toMatchObject({ delivered: "sent" });

          const plain = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            deferOpen: true,
          });
          const refused = yield* handlers["orchestrator.releaseWorker"]({
            threadId: plain.id,
          }).pipe(Effect.flip);
          expect(refused._tag).toBe("InvalidState");
        }),
      ),
  );

  it.effect(
    "Take over holds a worker by the typed message's path, sends it nothing, and Hand back ends it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const handlers = yield* orchestrationHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Queue worker" });
          yield* completeTurn(worker.session);
          const memo = outboxOf(workspaceId).pipe(
            Effect.map((outbox) => outbox.workers[worker.thread.id]),
          );
          const held = Effect.map(memo, (entry) => entry?.userIntervened === true);
          const said = texts(worker.session);
          expect(yield* held).toBe(false);

          yield* handlers["orchestrator.takeOverWorker"]({ threadId: worker.thread.id });
          yield* waitReal("the hold", held);
          // The same marks a typed message leaves, so it lapses the same way.
          const taken = yield* memo;
          expect(taken?.userInputAt).toBeTypeOf("number");
          expect(taken?.lastInputAt).toBe(taken?.userInputAt);
          // Nothing reached the worker, and the orchestrator is held off as after a message.
          yield* settle;
          expect(texts(worker.session)).toEqual(said);
          const theirs = yield* session
            .callTool("send_message", { threadId: worker.thread.id, text: "Status?" })
            .pipe(Effect.flip);
          expect(theirs.message).toMatch(/^user_intervened: /);

          yield* handlers["orchestrator.releaseWorker"]({ threadId: worker.thread.id });
          expect(yield* held).toBe(false);
          expect(
            yield* session.callTool("send_message", {
              threadId: worker.thread.id,
              text: "Status?",
            }),
          ).toMatchObject({ delivered: "sent" });

          const plain = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            deferOpen: true,
          });
          const refused = yield* handlers["orchestrator.takeOverWorker"]({
            threadId: plain.id,
          }).pipe(Effect.flip);
          expect(refused._tag).toBe("InvalidState");
        }),
      ),
  );

  it.effect(
    "keeps a worker readable once it is closed with its worktree: brief, report, PR and files",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const handlers = yield* orchestrationHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, {
            feature: "mail-retry",
            title: "Dead-letter table",
          });
          const id = worker.thread.id;
          yield* worker.session.callTool("report", {
            state: "done",
            summary: "The dead_letters table and its migration are in.",
          });
          yield* completeTurn(worker.session);
          yield* store.upsertMessage(id, {
            id: "edit-1",
            role: "assistant",
            parts: [
              {
                type: "tool-Write",
                toolCallId: "w1",
                state: "output-available",
                input: { file_path: "migrations/0042_dead_letters.py", content: "a\nb\n" },
                output: {
                  type: "create",
                  filePath: "migrations/0042_dead_letters.py",
                  content: "a\nb\n",
                },
              },
            ],
          } as unknown as GramUIMessage);
          yield* runtimes.updateThread(id, (thread) => ({
            ...thread,
            boundPr: { repo: "acme/shop", number: 428, monitor: false },
            completedReason: "prMerged",
          }));
          // Live, it is the ledger's; the finished list leaves it out.
          expect(yield* handlers["orchestrator.finishedWorkers"]({ workspaceId })).toEqual([]);

          yield* runtimes.close(id);
          yield* settle;
          const listed = yield* handlers["orchestrator.finishedWorkers"]({ workspaceId });
          expect(listed).toEqual([
            expect.objectContaining({
              threadId: id,
              title: "Dead-letter table",
              feature: "mail-retry",
              completedReason: "prMerged",
              kept: "closed",
              prs: [
                {
                  repo: "acme/shop",
                  number: 428,
                  url: "https://github.com/acme/shop/pull/428",
                  merged: true,
                },
              ],
              lastReport: expect.objectContaining({ state: "done" }),
            }),
          ]);
          const detail = yield* handlers["orchestrator.finishedWorker"]({ threadId: id });
          expect(detail.brief).toBeDefined();
          expect(detail.reports.map((report) => report.state)).toEqual(["done"]);
          expect(detail.files).toEqual([
            { path: "migrations/0042_dead_letters.py", additions: 2, deletions: 0 },
          ]);
          expect(detail.messages.some((message) => message.id === "edit-1")).toBe(true);
          expect(detail.archived).toBeUndefined();

          const gone = yield* handlers["orchestrator.finishedWorker"]({
            threadId: "no-such-thread" as ThreadId,
          }).pipe(Effect.flip);
          expect(gone._tag).toBe("ThreadNotFound");
        }),
      ),
  );

  it.effect("asks why a stalled worker is stuck without sending anything or holding it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "registry", title: "Page the list" });
        const id = worker.thread.id;
        yield* completeTurn(worker.session);
        const held = outboxOf(workspaceId).pipe(
          Effect.map((outbox) => outbox.workers[id]?.userIntervened === true),
        );
        const asked: Array<string> = [];
        const helper: HelperSchedulerShape = {
          schedule: <A, I>(job: HelperJob<A, I>) =>
            Effect.gen(function* () {
              yield* job.prompt;
              asked.push(job.system === STUCK_SYSTEM ? `stuck:${job.kind}` : job.kind);
              const value = { stuck: "It waits on the paging API." };
              return { _tag: "Done", value: value as A, cached: false } as const;
            }),
          latest: () => Effect.succeed(Option.none()),
          recordEvent: () => Effect.void,
          presence: () => Effect.void,
          status: Effect.die("not used"),
        };
        const assist = yield* assistHandlers.pipe(
          Effect.provide(
            ThreadAssistLive.pipe(
              Layer.provide(
                Layer.mergeAll(Layer.succeed(HelperScheduler, helper), ThreadVisibility.layer),
              ),
            ),
          ),
        );
        // Moved just now: nothing to ask, and no call.
        expect(yield* assist["thread.whyStuck"]({ threadId: id })).toBeNull();
        expect(asked).toEqual([]);

        const said = texts(worker.session);
        const told = texts(session);
        const now = yield* Clock.currentTimeMillis;
        yield* runtimes.updateThread(id, (thread) => ({
          ...thread,
          lastActivityAt: now - STUCK_AFTER_MS - 60_000,
        }));
        const view = yield* assist["thread.whyStuck"]({ threadId: id });
        expect(view).toMatchObject({ threadId: id, text: "It waits on the paging API." });
        expect(asked).toEqual(["stuck:stuck"]);
        yield* settle;
        // The helper only suggested: nothing reached the worker or its orchestrator, and the
        // worker is still the orchestrator's.
        expect(texts(worker.session)).toEqual(said);
        expect(texts(session)).toEqual(told);
        expect(yield* held).toBe(false);
      }),
    ),
  );

  it.effect(
    "never holds a worker for being watched: opening, reading, scrolling or leaving it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const threads = yield* threadHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Queue worker" });
          // A report the user hasn't seen, so opening the worker drafts its catch-up.
          yield* worker.session.callTool("report", { state: "progress", summary: "Backoff in." });
          yield* completeTurn(worker.session);
          const held = outboxOf(workspaceId).pipe(
            Effect.map((outbox) => outbox.workers[worker.thread.id]?.userIntervened === true),
          );
          const id = worker.thread.id;

          // The real assist handlers over a helper that answers at once, as the view calls them.
          const drafted: Array<string> = [];
          const helper: HelperSchedulerShape = {
            schedule: <A, I>(job: HelperJob<A, I>) =>
              Effect.gen(function* () {
                yield* job.prompt;
                const catchUp = job.system === CATCH_UP_SYSTEM;
                drafted.push(catchUp ? "catchUp" : job.kind);
                const value = catchUp
                  ? { catchUp: "The worker added backoff." }
                  : { recap: "The worker added backoff.", next: null, replies: [] };
                return { _tag: "Done", value: value as A, cached: false } as const;
              }),
            latest: () => Effect.succeed(Option.none()),
            recordEvent: () => Effect.void,
            presence: () => Effect.void,
            status: Effect.die("not used"),
          };
          const assist = yield* assistHandlers.pipe(
            Effect.provide(
              ThreadAssistLive.pipe(
                Layer.provide(
                  Layer.mergeAll(Layer.succeed(HelperScheduler, helper), ThreadVisibility.layer),
                ),
              ),
            ),
          );

          // What the worker view asks of the server as it opens, follows and scrolls, and what
          // leaving it writes: the catch-up and recap, the live feed, older pages, the read mark,
          // its waits.
          expect(yield* assist["thread.catchUp"]({ threadId: id })).toMatchObject({
            threadId: id,
            text: "The worker added backoff.",
          });
          expect(drafted).toEqual(["catchUp"]);
          // Not idle long enough for a recap; asking for one is still only a read.
          yield* assist["thread.recap"]({ threadId: id });
          const feed = yield* threads["thread.subscribe"]({ threadId: id }).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(feed.length).toBe(1);
          const { messages } = yield* (yield* ThreadStore).recentMessages(id, 1);
          const before = messages.at(-1)?.id;
          expect(before).toBeDefined();
          yield* threads["thread.history"]({ threadId: id, before: before! as MessageId });
          yield* threads["thread.markUnread"]({ threadId: id, unread: false });
          yield* threads["thread.listWaits"]({ threadId: id });
          yield* runtimes.updateThread(id, (thread) => ({ ...thread, lastViewedAt: Date.now() }));
          yield* settle;
          expect(yield* held).toBe(false);
          // The orchestrator may still message it.
          expect(
            yield* session.callTool("send_message", { threadId: id, text: "Status?" }),
          ).toMatchObject({ delivered: "sent" });
          yield* completeTurn(worker.session);

          // A message the user types is what takes it over.
          yield* threads["thread.send"]({ threadId: id, input: { text: "Use the other queue." } });
          yield* waitReal("the hold", held);
        }),
      ),
  );
});
