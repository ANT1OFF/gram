// Orchestration service: restarts and handoffs.
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationDigest, type ThreadId, type TurnId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit, run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { encodeOutbox } from "./outbox.ts";
import { IN_ERROR_DETAIL, Orchestration } from "./service.ts";
import {
  GIT_HEAVY,
  completeTurn,
  makeWorld,
  openOrchestrator,
  openOrchestratorAcross,
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
import { inServer, sessionsOf } from "./service-kit.ts";

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect(
    "after a restart: one away digest if something changed, none if not, and a pause sticks",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, {
              feature: "mail-trigger",
              title: "Mail trigger",
            });
            yield* completeTurn(worker.session);
            yield* TestClock.adjust("60 seconds");
            yield* waitSent(thread.id, 2);
            yield* completeTurn(session);
            // Filed just before the app quit, mid-delivery: the window never closed, and the outbox
            // still names a turn that died with the process.
            yield* worker.session.callTool("report", { state: "done", summary: "All green." });
            const outbox = yield* outboxOf(workspaceId);
            yield* store.putOutbox(
              workspaceId,
              encodeOutbox({
                ...outbox,
                inFlight: {
                  generation: 3,
                  turnId: "turn-lost" as TurnId,
                  reportSeqUpTo: 1,
                  nextSnapshot: {},
                  notesUpTo: 0,
                  claimedAt: 0,
                },
              }),
            );
            return { threadId: thread.id, workspaceId };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            const before = yield* outboxOf(first.workspaceId);
            expect(before.inFlight).toBeUndefined();
            expect(before.generation).toBe(2);
            yield* TestClock.adjust("60 seconds");
            const session = yield* waitSent(first.threadId, 1);
            yield* settle;
            expect(session.sent).toHaveLength(1);
            expect(session.sent[0]?.notice).toMatchObject({ variant: "away", generation: 3 });
            expect(session.sent[0]?.text).toContain("while you were away");
            expect(session.sent[0]?.text).toContain("All green.");
            expect(session.sent[0]?.text).toContain("working → done");
            yield* completeTurn(session);
            expect(yield* outboxOf(first.workspaceId)).toMatchObject({ generation: 3 });
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const fake = yield* FakeAgentControl;
            yield* TestClock.adjust("5 minutes");
            yield* settle;
            // Nothing changed while it was away: no session is even opened.
            expect(fake.sessions).toEqual([]);
            yield* orchestration.setPaused(first.workspaceId, true);
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const fake = yield* FakeAgentControl;
            expect((yield* store.getWorkspace(first.workspaceId)).paused?.reason).toBe("user");
            yield* TestClock.adjust("5 minutes");
            yield* settle;
            expect(fake.sessions).toEqual([]);
          }),
        );
      }),
  );

  it.effect("after a restart, a worker whose last turn failed reads error, not working", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
          // The brief's turn fails on the gateway, as gpt-6.1-sol's did.
          yield* worker.session.emit({
            type: "turnEnd",
            reason: "error",
            error: "exceeded retry limit, last status: 429 Too Many Requests",
            failure: { kind: "gatewayRefused", httpStatus: 429, retryable: false },
          });
          yield* waitReal(
            "the failure on the thread",
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              return (yield* store.getThread(worker.thread.id)).lastError !== undefined;
            }),
          );
          yield* settle;
          return { workspaceId, worker: worker.thread.id };
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const ledger = yield* orchestration.ledger(first.workspaceId);
          const row = ledger.features
            .flatMap((f) => f.workers)
            .find((w) => w.threadId === first.worker);
          expect(row).toMatchObject({
            state: "error",
            status: "cold",
            lastError: { kind: "gatewayRefused", httpStatus: 429 },
          });
        }),
      );
    }),
  );

  it.effect(
    "after a restart, an overlap already told isn't told again as each worker is sampled",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { session, thread } = yield* openOrchestrator(world);
            const a = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
            const b = yield* spawn(session, { feature: "billing", title: "Billing" });
            for (const [worker, text] of [
              [a, "a\n"],
              [b, "b\n"],
            ] as const) {
              fs.writeFileSync(nodePath.join(worker.thread.checkout.path, "shared.ts"), text);
              run(worker.thread.checkout.path, "add", "shared.ts");
              yield* publishGit(world, worker.thread, { changesToken: "t1", changedFiles: 1 });
            }
            // Shared paths are evidence, but alone need no coordination turn.
            yield* TestClock.adjust("60 seconds");
            yield* settle;
            expect(session.sent).toHaveLength(1);
            yield* a.session.callTool("report", {
              state: "progress",
              summary: "Shared-file edits ready for review.",
            });
            yield* TestClock.adjust("60 seconds");
            yield* waitSent(thread.id, 2);
            expect(session.sent[1]?.text).toContain(
              "advisory overlap, not a verified git conflict",
            );
            expect(session.sent[1]?.text).toContain("shared.ts");
            expect((session.sent[1]!.notice as OrchestrationDigest).reasons).toEqual([
              '"Mail trigger" reported progress',
            ]);
            yield* completeTurn(session);
            return { threadId: thread.id, a: a.thread, b: b.thread };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            for (const worker of [first.a, first.b]) {
              yield* publishGit(world, worker, { changesToken: "t2", changedFiles: 1 });
              yield* settle;
            }
            // Something else wakes it, and the old pair is not among the reasons.
            const orchestration = yield* Orchestration;
            yield* orchestration.recordReport(first.a.id, { state: "progress", summary: "On it." });
            yield* TestClock.adjust("60 seconds");
            const session = yield* waitSent(first.threadId, 1);
            expect(session.sent[0]?.text).toContain("reported progress");
            expect(
              (session.sent[0]!.notice as OrchestrationDigest).changes.every(
                (change) => !change.note?.includes("advisory overlap"),
              ),
            ).toBe(true);
          }),
        );
      }),
    GIT_HEAVY,
  );

  it.effect(
    "after a restart: names the workers it cut off and their stopped work, and continues them",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const cut = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
            const idle = yield* spawn(session, { feature: "stock", title: "Stock" });
            const parked = yield* spawn(session, { feature: "old", title: "Parked" });
            const completed = yield* spawn(session, { feature: "older", title: "Completed" });
            const unknown = yield* spawn(session, { feature: "oldest", title: "Unknown PR" });
            yield* completeTurn(unknown.session);
            yield* completeTurn(cut.session);
            yield* completeTurn(idle.session);
            yield* completeTurn(parked.session);
            yield* completeTurn(completed.session);
            yield* idle.session.emit({
              type: "backgroundTasks",
              tasks: [
                {
                  taskId: "b1",
                  kind: "shell",
                  description: "Run the checks",
                  command: "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 pnpm check",
                  startedAt: 0,
                },
              ],
            });
            const [kept] = yield* waitReal(
              "the shell in the worker's memo",
              outboxOf(workspaceId).pipe(
                Effect.map((outbox) => outbox.workers[idle.thread.id]?.background),
              ),
            );
            // Stored redacted: the row outlives the command.
            expect(kept?.command).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
            yield* TestClock.adjust("60 seconds");
            yield* waitSent(thread.id, 2);
            yield* completeTurn(session);
            // A turn the process died in: shutting a runtime down would end it, so it is written
            // the way a crash leaves it.
            yield* store.startTurn(cut.thread.id, "turn-cut" as TurnId, 1);
            // It reported in the turn the crash cut off, which will never be heard to end.
            yield* cut.session.callTool("report", { state: "progress", summary: "Halfway." });
            // Cut off too, but long finished: nothing a restart note or a continue is for.
            const runtimes = yield* ThreadRuntimes;
            yield* parked.session.emit({
              type: "backgroundTasks",
              tasks: [{ taskId: "b2", kind: "shell", description: "Dev server", startedAt: 0 }],
            });
            yield* waitReal(
              "the parked worker's shell in its memo",
              outboxOf(workspaceId).pipe(
                Effect.map((outbox) => outbox.workers[parked.thread.id]?.background),
              ),
            );
            yield* runtimes.updateThread(parked.thread.id, (t) => ({ ...t, parked: true }));
            yield* runtimes.updateThread(completed.thread.id, (t) => ({ ...t, completedAt: 1 }));
            yield* store.startTurn(parked.thread.id, "turn-parked" as TurnId, 1);
            yield* store.startTurn(completed.thread.id, "turn-completed" as TurnId, 1);
            // Bound to a PR nobody could look up: it may have merged meanwhile, so it isn't asked.
            yield* runtimes.updateThread(unknown.thread.id, (t) => ({
              ...t,
              boundPr: { repo: "acme/shop", number: 99, monitor: false },
            }));
            yield* store.startTurn(unknown.thread.id, "turn-unknown" as TurnId, 1);
            yield* store.updateSettings((settings) => ({
              ...settings,
              workspaces: { continueAfterRestart: true },
            }));
            return {
              threadId: thread.id,
              workspaceId,
              cut: cut.thread.id,
              idle: idle.thread.id,
              over: [parked.thread.id, completed.thread.id],
              unknown: unknown.thread.id,
            };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            // The cut-off worker is asked once to go on; the idle one is left alone.
            yield* settle;
            // Its report's turn is over, so the turn it is asked to go on in isn't taken for it.
            expect((yield* outboxOf(first.workspaceId)).workers[first.cut]?.reportInTurn).toBe(
              undefined,
            );
            const cut = yield* waitSent(first.cut, 1);
            expect(cut.sent[0]?.text).toContain("Continue where you left off");
            expect(cut.sent[0]?.origin).toBeUndefined();
            // Opened with its worker policy, the boot having waited for it.
            expect(cut.options.audience).toBe("worker");
            yield* completeTurn(cut);
            yield* TestClock.adjust("60 seconds");
            const session = yield* waitSent(first.threadId, 1);
            const digest = session.sent[0]?.text ?? "";
            expect(digest).toContain("while you were away");
            expect(digest).toContain(
              `A restart cut these 2 workers off mid-turn, so none is working now whatever the ledger says: “Mail trigger” [thread ${first.cut}] (asked to continue where it left off), `,
            );
            expect(digest).toContain(
              `It also stopped background work, as the agents described it: “Stock” [thread ${first.idle}]: shell \``,
            );
            const fake = yield* FakeAgentControl;
            expect(fake.sessions.filter((each) => each.options.threadId === first.idle)).toEqual(
              [],
            );
            expect(digest).toContain("pnpm check`.");
            expect(digest).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
            expect((yield* outboxOf(first.workspaceId)).workers[first.idle]?.background).toBe(
              undefined,
            );
            expect(digest).toContain(
              `“Unknown PR” [thread ${first.unknown}] (idle until messaged)`,
            );
            expect(fake.sessions.filter((each) => each.options.threadId === first.unknown)).toEqual(
              [],
            );
            for (const over of first.over) {
              expect(digest).not.toContain(`[thread ${over}] (`);
              expect(fake.sessions.filter((each) => each.options.threadId === over)).toEqual([]);
              expect((yield* outboxOf(first.workspaceId)).workers[over]?.background).toBe(
                undefined,
              );
            }
          }),
        );
      }),
  );

  it.effect(
    "after a restart with no saved choice, never resumes a cut-off worker",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const config = {};
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { session } = yield* openOrchestrator(world);
            const cut = yield* spawn(session, { feature: "mail-trigger", title: "Mail" });
            yield* completeTurn(cut.session);
            const store = yield* ThreadStore;
            yield* store.startTurn(cut.thread.id, "turn-cut" as TurnId, 1);
            return cut.thread.id;
          }),
          config,
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            const fake = yield* FakeAgentControl;
            const resumed = fake.sessions.filter((each) => each.options.threadId === first);
            expect(resumed.flatMap((each) => each.sent)).toEqual([]);
          }),
          config,
        );
      }),
    GIT_HEAVY,
  );

  it.effect("after a restart that changed nothing else, still says which worker it cut off", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const cut = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
          yield* completeTurn(cut.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          yield* completeTurn(session);
          yield* settle;
          yield* store.startTurn(cut.thread.id, "turn-cut" as TurnId, 1);
          return { threadId: thread.id, cut: cut.thread.id, workspaceId };
        }),
      );

      // Nothing in the ledger moved, and the digest still goes, to say so.
      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          const session = yield* waitSent(first.threadId, 1);
          expect(session.sent[0]?.text).toContain(
            `“Mail trigger” [thread ${first.cut}] (idle until messaged)`,
          );
          yield* completeTurn(session);
        }),
      );
    }),
  );

  it.effect(
    "rolls a worker's other repos into its ledger row, its PR state and the overlap check",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const { session, workspaceId, other } = yield* openOrchestratorAcross(world);
          const across = yield* spawn(session, {
            feature: "mail-trigger",
            title: "Mail trigger",
            alsoIn: ["warehouse"],
          });
          const single = yield* spawn(session, {
            project: "warehouse",
            feature: "stock",
            title: "Stock",
          });
          const extra = across.thread.extraCheckouts![0]!;
          const rowOf = (threadId: ThreadId) =>
            orchestration
              .ledger(workspaceId)
              .pipe(
                Effect.map((ledger) =>
                  ledger.features
                    .flatMap((feature) => feature.workers)
                    .find((worker) => worker.threadId === threadId)!,
                ),
              );
          // The service samples the other worktree itself, on its own fiber and with real git.
          const rowWhen = (
            threadId: ThreadId,
            holds: (row: Effect.Success<ReturnType<typeof rowOf>>) => boolean,
          ) =>
            waitReal(
              "the ledger to catch up",
              rowOf(threadId).pipe(Effect.map((row) => (holds(row) ? row : undefined))),
            );
          expect((yield* rowOf(across.thread.id)).alsoIn).toEqual([
            {
              projectId: other.id,
              project: "warehouse",
              localGate:
                "no local check configured for warehouse; local gate OFF — CI and GitHub rules apply",
              branch: "feat/mail-trigger",
              changedFiles: 0,
            },
          ]);
          expect((yield* rowOf(single.thread.id)).alsoIn).toBeUndefined();

          // Both change the same file of the second repo, one of them from its extra worktree, and
          // not the same way. Staged, since a file git doesn't track collides with nothing.
          for (const root of [extra.path, single.thread.checkout.path]) {
            fs.mkdirSync(nodePath.join(root, "src"), { recursive: true });
            fs.writeFileSync(
              nodePath.join(root, "src", "stock.ts"),
              `export const at = "${root}";\n`,
            );
            run(root, "add", "src/stock.ts");
          }
          // The same path in the first repo is another file altogether.
          fs.mkdirSync(nodePath.join(across.thread.checkout.path, "src"), { recursive: true });
          fs.writeFileSync(nodePath.join(across.thread.checkout.path, "src", "mail.ts"), "\n");
          run(across.thread.checkout.path, "add", "src/mail.ts");
          yield* publishGit(world, single.thread, { changesToken: "t1", changedFiles: 1 });
          yield* publishGit(world, across.thread, { changesToken: "t1", changedFiles: 1 });
          expect(
            yield* rowWhen(across.thread.id, (row) => row.overlapsWith.length > 0),
          ).toMatchObject({
            changedFiles: 1,
            alsoIn: [{ project: "warehouse", changedFiles: 1 }],
            overlapsWith: [single.thread.id],
          });
          expect((yield* rowOf(single.thread.id)).overlapsWith).toEqual([across.thread.id]);
          // The window opens when the service gets to the publish, which it does in its own time
          // (it runs git), so the clock is moved until the digest is there.
          const digests = (count: number) =>
            waitReal(
              `digest ${count}`,
              TestClock.adjust("60 seconds").pipe(Effect.map(() => session.sent.length >= count)),
            );
          // An advisory overlap remains in the ledger without waking the orchestrator.
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          expect(session.sent).toHaveLength(1);
          yield* across.session.callTool("report", {
            state: "progress",
            summary: "Extra repo edits ready for review",
          });
          yield* digests(2);
          expect(session.sent[1]?.text).toContain("advisory overlap, not a verified git conflict");
          expect(session.sent[1]?.text).toContain(
            "also in warehouse (no local check configured for warehouse; local gate OFF — CI and GitHub rules ap…, branch feat/mail-trigger, 1 changed)",
          );
          yield* completeTurn(session);

          // A PR in each repo. Until the second one's badge has been looked up the worker is in
          // review, and the ledger names it by repo and number alone.
          const approved = {
            bots: ["example-code-review"],
            verdictOnHead: "approved" as const,
            reviewedHead: true,
            roundInFlight: false,
            threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
          };
          const ready = { checks: "passing" as const, mergeState: "CLEAN", review: approved };
          const theirs = (overrides: Partial<Parameters<typeof prBadge>[0]>) =>
            prBadge({
              number: 7,
              url: "https://github.com/acme/warehouse/pull/7",
              ...ready,
              ...overrides,
            });
          yield* runtimes.updateThread(across.thread.id, (t) => ({
            ...t,
            boundPr: { repo: "acme/shop", number: 12, monitor: false },
            extraPrs: [{ repo: "acme/warehouse", number: 7, monitor: false }],
          }));
          yield* publishGit(world, across.thread, { changesToken: "t1", pr: prBadge(ready) });
          expect(yield* rowWhen(across.thread.id, (row) => row.pr !== undefined)).toMatchObject({
            state: "inReview",
            pr: { repo: "acme/shop", number: 12, verdictOnHead: "approved", botOnHead: "reviewed" },
            alsoIn: [{ pr: { repo: "acme/warehouse", number: 7 } }],
          });
          expect((yield* rowOf(across.thread.id)).alsoIn![0]!.pr).toEqual({
            repo: "acme/warehouse",
            number: 7,
          });

          const publish = (extraPr: ReturnType<typeof theirs>, own = prBadge(ready)) =>
            publishGit(world, across.thread, {
              changesToken: "t1",
              pr: own,
              extraPrs: [extraPr],
            });
          yield* publish(theirs({ checks: "pending" }));
          expect(
            yield* rowWhen(across.thread.id, (row) => row.alsoIn?.[0]?.pr?.checks !== undefined),
          ).toMatchObject({
            state: "inReview",
            alsoIn: [{ pr: { repo: "acme/warehouse", number: 7, checks: "pending" } }],
          });
          yield* publish(theirs({}));
          yield* rowWhen(across.thread.id, (row) => row.state === "readyToMerge");
          // A red check nobody requires leaves it ready, and the ledger says what is red.
          yield* publish(
            theirs({ checks: "failing", requiredChecks: "passing", mergeState: "UNSTABLE" }),
          );
          expect(
            (yield* rowWhen(
              across.thread.id,
              (row) => row.alsoIn?.[0]?.pr?.mergeState === "UNSTABLE",
            )).alsoIn?.[0]?.pr?.checks,
          ).toBe("passing (not required: failing)");
          expect((yield* rowOf(across.thread.id)).state).toBe("readyToMerge");
          // One of the two merged leaves the worker waiting on the other alone.
          yield* publish(theirs({ state: "MERGED" }));
          yield* settle;
          expect((yield* rowOf(across.thread.id)).state).toBe("readyToMerge");
          yield* publish(theirs({ state: "MERGED" }), prBadge({ ...ready, state: "MERGED" }));
          yield* rowWhen(across.thread.id, (row) => row.state === "merged");

          // The second repo's PR moving is a reason of its own, under the repo's name.
          yield* digests(3);
          expect(session.sent[2]?.text).toContain(
            "'Mail trigger (acme/warehouse)': pull request opened; checks passed; pull request merged",
          );
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "hands off to a fresh session under the same thread: checkpoint, handoff mark, boot from memory",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const fake = yield* FakeAgentControl;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          yield* session.callTool("memory_write", {
            path: "MEMORY.md",
            content: "# Memory\n- 2026-09-24 (user): ship the mail trigger first.\n",
          });
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });

          // Past 90 %: the next digest says so once, asks for memory to be current, and leaves it
          // at that.
          yield* runtimes.send(thread.id, { text: "How is it going?" });
          yield* waitSent(thread.id, 2);
          yield* session.emit({
            type: "usage",
            tokens: { inputTokens: 10, outputTokens: 10 },
            contextWindow: 200_000,
            contextTokens: 184_000,
          });
          yield* completeTurn(session);
          yield* completeTurn(worker.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 3);
          expect(session.sent[2]?.text).toContain(
            "Your context is 92 % full; write anything unsaved to memory.",
          );
          expect(session.sent[2]?.text).not.toContain("ask the user for a handoff");
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).contextNoted).toBe(true);
          // A turn of the user's that compacts and fills up again ends above 90 %, with no digest
          // in it, and still ends the crossing: the reading in between was below.
          yield* runtimes.send(thread.id, { text: "Carry on" });
          yield* waitSent(thread.id, 4);
          for (const contextTokens of [60_000, 186_000]) {
            yield* session.emit({
              type: "usage",
              tokens: { inputTokens: 10, outputTokens: 10 },
              contextWindow: 200_000,
              contextTokens,
            });
          }
          yield* waitReal(
            "the crossing to be cleared",
            outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.contextNoted === false)),
          );
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).contextNoted).toBe(false);
          expect(yield* sessionsOf(thread.id)).toHaveLength(1);

          const previous = (yield* store.getThread(thread.id)).agentSessionId;
          expect(previous).toBe(session.agentSessionId);
          expect((yield* orchestration.handoff(workspaceId, "user")).id).toBe(thread.id);
          yield* waitSent(thread.id, 5);
          const checkpoint = session.sent[4]!;
          expect(checkpoint.notice).toMatchObject({ variant: "checkpoint", generation: 2 });
          expect(checkpoint.text).toContain("The user asked for a handoff");
          expect(checkpoint.text).toContain("`memory_write`");
          expect(checkpoint.text).toContain("reply `ready`");
          // It acknowledges nothing, and a second request while it runs is refused.
          expect(yield* outboxOf(workspaceId)).toMatchObject({
            generation: 2,
            handoff: { phase: "checkpoint", reason: "user" },
          });
          expect((yield* outboxOf(workspaceId)).inFlight).toBeUndefined();
          const twice = yield* orchestration.handoff(workspaceId, "user").pipe(Effect.flip);
          expect(twice).toMatchObject({ _tag: "InvalidState" });
          expect(twice.message).toContain("already under way");

          yield* session.completeTurn("ready");
          const fresh = yield* waitReal(
            "the fresh session's boot digest",
            Effect.sync(() =>
              fake.sessions.find(
                (s) => s !== session && s.options.threadId === thread.id && s.sent.length > 0,
              ),
            ),
          );
          expect(session.closed).toBe(true);
          expect(fresh.options.resumeId).toBeUndefined();
          expect(fresh.agentSessionId).not.toBe(previous);
          expect(fresh.options).toMatchObject({
            audience: "orchestrator",
            outwardGate: "irreversible",
          });
          expect(fresh.options.instructions).toContain('orchestrator of the "shop" workspace');
          const [boot] = fresh.sent;
          expect(boot?.notice).toMatchObject({ variant: "boot", generation: 3, changes: [] });
          expect(boot?.text).toContain("ship the mail trigger first");
          expect(boot?.text).toContain("a fresh session after a handoff");
          expect(boot?.text).toContain('"Mail trigger"');
          expect(boot?.text).toContain("workers at once");
          expect(boot?.text).not.toContain("% full");
          yield* completeTurn(fresh);
          // A fresh session's first crossing is noted again.
          expect((yield* outboxOf(workspaceId)).contextNoted).not.toBe(true);

          // The same thread, slot and workers; only the agent session is new.
          const after = yield* store.getThread(thread.id);
          expect(after).toMatchObject({ role: "orchestrator", workspaceId });
          expect(after.agentSessionId).toBe(fresh.agentSessionId);
          expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
            thread.id,
          );
          expect((yield* store.getThread(worker.thread.id)).spawnedBy?.threadId).toBe(thread.id);
          const outbox = yield* outboxOf(workspaceId);
          expect(outbox).toMatchObject({ booted: true, generation: 3 });
          expect(outbox.handoff).toBeUndefined();
          const messages = yield* store.listMessages(thread.id);
          const marks = messages.flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "data-handoff" ? [part.data] : [])),
          );
          expect(marks).toEqual([
            { previousAgentSessionId: previous, reason: "user", at: marks[0]!.at },
          ]);
          expect((yield* store.listOrchestrationEvents(workspaceId, 0)).map((e) => e.kind)).toEqual(
            expect.arrayContaining(["handoffRequested", "handoff"]),
          );

          // What was said before the handoff is the old session's, so the new one can't be
          // rewound or forked to it; what came after can.
          const ready = messages.find(
            (message) =>
              message.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text === "ready"),
          )!;
          const rewind = yield* runtimes.rewindTarget(thread.id, ready.id).pipe(Effect.flip);
          expect(rewind.message).toContain("before a session handoff");
          const fork = yield* runtimes.forkTarget(thread.id, ready.id).pipe(Effect.flip);
          expect(fork.message).toContain("before a session handoff");
          expect((yield* runtimes.forkTarget(thread.id, undefined)).source.id).toBe(thread.id);

          // The digest after the boot is a diff against the snapshot, as ever.
          yield* worker.session.callTool("report", { state: "done", summary: "All green." });
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          expect(fresh.sent[1]?.notice).toMatchObject({ variant: "digest", generation: 4 });
          expect(fresh.sent[1]?.text).toContain("working → done");
        }),
      ),
  );

  it.effect("a handoff lets a digest in flight finish first, and acknowledges nothing itself", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const fake = yield* FakeAgentControl;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(thread.id, 2);
        expect((yield* outboxOf(workspaceId)).inFlight?.generation).toBe(2);

        // Asked for while the digest's turn runs: the checkpoint waits its turn behind it.
        yield* orchestration.handoff(workspaceId, "user");
        yield* settle;
        expect(session.sent).toHaveLength(2);
        yield* session.completeTurn();
        yield* waitSent(thread.id, 3);
        expect(session.sent[2]?.notice).toMatchObject({ variant: "checkpoint", generation: 2 });
        const acked = yield* outboxOf(workspaceId);
        expect(acked).toMatchObject({ generation: 2, handoff: { phase: "checkpoint" } });
        expect(acked.inFlight).toBeUndefined();
        expect(Object.keys(acked.snapshot)).toEqual([worker.thread.id]);

        // A wake meanwhile is held back rather than sent to the session that is going.
        yield* worker.session.callTool("report", { state: "done", summary: "All green." });
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(3);

        // The user pausing meanwhile doesn't strand the handoff they asked for: the fresh session
        // still gets its boot, which says it is paused.
        yield* orchestration.setPaused(workspaceId, true);
        yield* session.completeTurn("ready");
        const fresh = yield* waitReal(
          "the fresh session's boot digest",
          Effect.sync(() =>
            fake.sessions.find(
              (s) => s !== session && s.options.threadId === thread.id && s.sent.length > 0,
            ),
          ),
        );
        // The boot is still a diff against what the last acknowledged digest said.
        expect(fresh.sent[0]?.notice).toMatchObject({
          variant: "boot",
          generation: 3,
          paused: { reason: "user" },
        });
        expect(fresh.sent[0]?.text).toContain("Paused (user)");
        expect(fresh.sent[0]?.text).toContain("working → done");
        expect(fresh.sent[0]?.text).toContain("All green.");
        yield* completeTurn(fresh);
        expect(yield* outboxOf(workspaceId)).toMatchObject({ booted: true, generation: 3 });
        // One boot, not an opening: the pause holds every digest after it.
        const store = yield* ThreadStore;
        expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");
        yield* worker.session.callTool("report", { state: "progress", summary: "PR opened." });
        yield* TestClock.adjust("5 minutes");
        yield* settle;
        expect(fresh.sent).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "an orchestrator in error is handed off without a checkpoint, which ends its pause",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const fake = yield* FakeAgentControl;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          yield* runtimes.send(thread.id, { text: "hello" });
          yield* waitSent(thread.id, 2);
          yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
          yield* waitStatus(thread.id, "error");
          const at = yield* Clock.currentTimeMillis;
          yield* store.updateWorkspace(workspaceId, (current) => ({
            ...current,
            paused: { reason: "deliveryFailed", detail: IN_ERROR_DETAIL, at },
          }));

          yield* orchestration.handoff(workspaceId, "user");
          const fresh = yield* waitReal(
            "the fresh session's boot digest",
            Effect.sync(() =>
              fake.sessions.find(
                (s) => s !== session && s.options.threadId === thread.id && s.sent.length > 0,
              ),
            ),
          );
          // Nothing was asked of the session that couldn't answer.
          expect(session.sent).toHaveLength(2);
          expect(fresh.options.resumeId).toBeUndefined();
          expect(fresh.sent[0]?.notice).toMatchObject({ variant: "boot" });
          expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
          expect((yield* outboxOf(workspaceId)).handoff).toBeUndefined();
          const marks = (yield* store.listMessages(thread.id)).flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "data-handoff" ? [part.data] : [])),
          );
          expect(marks).toMatchObject([
            { previousAgentSessionId: session.agentSessionId, reason: "user" },
          ]);

          // With nobody in the slot, there is nothing to hand off.
          yield* completeTurn(fresh);
          yield* runtimes.close(thread.id);
          yield* settle;
          const empty = yield* orchestration.handoff(workspaceId, "user").pipe(Effect.flip);
          expect(empty.message).toContain("no orchestrator");
        }),
      ),
  );

  it.effect("a restart in the middle of a handoff picks it up, at the checkpoint or after it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          yield* orchestration.handoff(workspaceId, "user");
          yield* waitSent(thread.id, 2);
          // The app quits while the checkpoint turn runs.
          return { threadId: thread.id, workspaceId, sessionId: session.agentSessionId };
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          // The old session is resumed and asked again; then the handoff runs its course.
          const resumed = yield* waitSent(first.threadId, 1);
          expect(resumed.options.resumeId).toBe(first.sessionId);
          expect(resumed.sent[0]?.notice).toMatchObject({ variant: "checkpoint" });
          yield* resumed.completeTurn("ready");
          const fresh = yield* waitReal(
            "the fresh session's boot digest",
            Effect.sync(() =>
              fake.sessions.find(
                (s) => s !== resumed && s.options.threadId === first.threadId && s.sent.length > 0,
              ),
            ),
          );
          expect(fresh.options.resumeId).toBeUndefined();
          expect(fresh.sent[0]?.notice).toMatchObject({ variant: "boot" });
          yield* completeTurn(fresh);
          const outbox = yield* outboxOf(first.workspaceId);
          expect(outbox.handoff).toBeUndefined();

          // The next run died after the session was replaced, before the transcript was marked.
          yield* store.putOutbox(
            first.workspaceId,
            encodeOutbox({
              ...outbox,
              handoff: {
                reason: "context",
                at: 4_242,
                phase: "fresh",
                previousAgentSessionId: "the-session-before",
              },
            }),
          );
        }),
      );

      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const booted = yield* waitSent(first.threadId, 1);
          expect(booted.sent[0]?.notice).toMatchObject({ variant: "boot" });
          yield* completeTurn(booted);
          expect(yield* outboxOf(first.workspaceId)).toMatchObject({ booted: true });
          expect((yield* outboxOf(first.workspaceId)).handoff).toBeUndefined();
          const marks = (yield* store.listMessages(first.threadId)).flatMap((message) =>
            message.parts.flatMap((part) => (part.type === "data-handoff" ? [part.data] : [])),
          );
          expect(marks.at(-1)).toEqual({
            previousAgentSessionId: "the-session-before",
            reason: "context",
            at: 4_242,
          });
          expect(marks).toHaveLength(2);
        }),
      );
    }),
  );
});
