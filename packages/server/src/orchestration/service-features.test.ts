// Orchestration service: autonomy, features over the RPCs, and the ledger stream.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type DreamId,
  type OrchestratorLedger,
  type MessageId,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit, makeRepo } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { orchestrationHandlers } from "./handler.ts";
import { Orchestration } from "./service.ts";
import {
  atAutonomy,
  collectEvents,
  completeTurn,
  openOrchestrator,
  openOrchestratorAcross,
  outboxOf,
  prBadge,
  publishGit,
  settle,
  spawn,
  stallGit,
  waitReal,
  waitSent,
  waitStatus,
  watchedPr,
} from "./test-harness.ts";
import { inServer, sessionsOf, allSent, sentCount, baseBadge } from "./service-kit.ts";

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect(
    "opens sessions at the workspace's autonomy, and reloads them when the level changes",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          const parked = yield* spawn(session, { feature: "billing" });
          yield* completeTurn(parked.session);
          yield* session.callTool("archive_thread", { threadId: parked.thread.id });
          expect(session.options.instructions).toContain("autonomy is `publish`");
          expect(worker.session.options.instructions).toContain(
            "Push your branch and open pull requests yourself.",
          );

          // The orchestrator is idle and reopens at once; the worker finishes its turn first,
          // under the level it started with.
          const full = yield* atAutonomy(thread, "full");
          expect(full.options).toMatchObject({ audience: "orchestrator" });
          expect(full.options.outwardGate).toBeUndefined();
          expect(full.options.instructions).toContain("autonomy is `full`");
          expect(full.options.resumeId).toBe(session.agentSessionId);
          expect(worker.session.closed).toBe(false);
          expect(yield* sessionsOf(worker.thread.id)).toHaveLength(1);
          yield* worker.session.completeTurn();
          const freed = yield* waitReal(
            "the worker's session at full",
            sessionsOf(worker.thread.id).pipe(Effect.map((sessions) => sessions[1])),
          );
          expect(freed.options).toMatchObject({ audience: "worker" });
          expect(freed.options.outwardGate).toBeUndefined();
          expect(freed.options.instructions).toContain(
            "Push and open pull requests without approval",
          );

          const supervised = yield* atAutonomy(thread, "supervised");
          expect(supervised.options).toMatchObject({ outwardGate: "all" });
          const held = yield* waitReal(
            "the worker's session at supervised",
            sessionsOf(worker.thread.id).pipe(Effect.map((sessions) => sessions[2])),
          );
          expect(held.options).toMatchObject({ audience: "worker", outwardGate: "all" });
          expect(held.options.instructions).toContain(
            "Pushing, opening a pull request and merging ask the user first.",
          );

          // Anything else about the charter leaves the sessions where they are, and so does a
          // parked worker's: it opens under the level in force if it is ever woken.
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy: "supervised",
            maxConcurrentWorkers: 3,
          });
          yield* settle;
          expect(yield* sessionsOf(thread.id)).toHaveLength(3);
          expect(yield* sessionsOf(worker.thread.id)).toHaveLength(3);
          expect(yield* sessionsOf(parked.thread.id)).toHaveLength(1);
          // The boot digest of a session opened now says the level with the rest of the charter.
          expect(session.sent[0]?.text).toContain("autonomy publish:");
        }),
      ),
  );

  it.effect("hears of a worker's question within a minute at full, where it may answer it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const opened = yield* openOrchestrator(world);
        const session = yield* atAutonomy(opened.thread, "full");
        const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* worker.session.emit(
          {
            type: "request",
            request: {
              kind: "question",
              id: "req-1" as RequestId,
              questions: [
                { question: "Which port?", header: "Port", options: [], multiSelect: false },
              ],
            },
          },
          {
            type: "request",
            request: { kind: "plan", id: "req-2" as RequestId, plan: "1. Ship it." },
          },
        );
        const store = yield* ThreadStore;
        yield* waitReal(
          "both requests",
          store.listRequests(worker.thread.id).pipe(Effect.map((all) => all.length === 2)),
        );
        yield* settle;
        yield* TestClock.adjust("59 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(0);
        yield* TestClock.adjust("3 seconds");
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(opened.thread.id, 1);
        const digest = session.sent[0]!.text;
        expect(digest).toContain(
          "'Mail trigger' has had a question open for 1 min; answer_worker can answer it",
        );
        expect(digest).toContain('on question [request req-1]: "Which port?"');
        expect(digest).toContain('on plan [request req-2]: "1. Ship it."');
        // The plan is the user's at every level, and waits the ten minutes it always did.
        expect(digest).not.toContain("on the user (plan)");
        yield* completeTurn(session);
        yield* TestClock.adjust("7 minutes");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        yield* waitSent(opened.thread.id, 2);
        expect(session.sent[1]?.text).toContain(
          "'Mail trigger' has waited 10 min on the user (plan)",
        );
      }),
    ),
  );

  it.effect(
    "takes the user's stage and group over the RPCs, and tells the orchestrator in its next digest",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const handlers = yield* orchestrationHandlers;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "board", title: "Board" });
          yield* session.callTool("set_stage", {
            feature: "board",
            plan: ["contract", "build", "preview"],
            stage: "contract",
          });
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          // Its own stage is no news to it: nothing was sent.
          expect(session.sent).toHaveLength(1);

          const events = yield* collectEvents(["orchestration.changed", "workspaces.changed"]);
          const moved = yield* handlers["orchestrator.setStage"]({
            workspaceId,
            feature: "board",
            stage: "preview",
            note: "deployed by hand",
          });
          expect(moved.stages?.["board"]).toEqual({
            plan: ["contract", "build", "preview"],
            stage: "preview",
            note: "deployed by hand",
            setBy: "user",
            setAt: expect.any(Number),
          });
          expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(["orchestration.changed", "workspaces.changed"]),
          );
          const grouped = yield* handlers["orchestrator.setGroup"]({
            workspaceId,
            feature: "board",
            group: "release-0-4",
          });
          expect(grouped.groups).toEqual({ "release-0-4": { features: ["board"] } });
          yield* handlers["orchestrator.setStage"]({
            workspaceId,
            group: "release-0-4",
            stage: "rc",
            plan: ["merge", "rc", "release"],
          });
          // Putting it where it already is moves nothing, and says nothing.
          yield* handlers["orchestrator.setGroup"]({
            workspaceId,
            feature: "board",
            group: "release-0-4",
          });
          expect((yield* outboxOf(workspaceId)).notes).toEqual([
            'The user moved feature board to stage "preview" (deployed by hand). Their word stands; work from there.',
            "The user put feature board in group release-0-4.",
            'The user moved group release-0-4 to stage "rc". Their word stands; work from there.',
          ]);

          for (const [input, message] of [
            [{ feature: "board", stage: "shipped" }, "isn't in this plan"],
            [{ feature: "nobody", stage: "x" }, "No feature is called nobody"],
            [{ stage: "x" }, "one and not both"],
          ] as const) {
            const refused = yield* handlers["orchestrator.setStage"]({
              workspaceId,
              ...input,
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
            expect(refused.message).toContain(message);
          }
          const missing = yield* handlers["orchestrator.setStage"]({
            workspaceId: "nowhere" as typeof workspaceId,
            feature: "board",
            stage: "x",
          }).pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "NotFound" });

          // The user's word doesn't wake the orchestrator by itself…
          yield* TestClock.adjust("2 minutes");
          yield* settle;
          expect(session.sent).toHaveLength(1);
          // …and is in the next digest that something else sends.
          yield* completeTurn(worker.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, 2);
          const digest = session.sent[1]!.text;
          expect(digest).toContain(
            'Group release-0-4 (working) · stage "rc" (2 of 3: merge → rc → release), set by the user: board',
          );
          expect(digest).toContain(
            'board [group release-0-4] (working) · stage "preview" (3 of 3: contract → build → preview), set by the user, note: deployed by hand:',
          );
          expect(digest).toContain('- The user moved feature board to stage "preview"');
          yield* completeTurn(session);
          expect((yield* outboxOf(workspaceId)).notes).toEqual([]);
          expect((yield* store.getWorkspace(workspaceId)).stages?.["board"]?.setBy).toBe("user");
        }),
      ),
  );

  it.effect(
    "archives a feature over the RPC by parking its workers, never while one runs, and tells the orchestrator",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* orchestrationHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          const api = yield* spawn(session, {
            feature: "board",
            title: "Api",
            branch: "feat/board-api",
          });
          const other = yield* spawn(session, { feature: "docs", title: "Docs" });

          // Both are still on their briefs: parking them would only hide the work.
          const busy = yield* handlers["orchestrator.archiveFeature"]({
            workspaceId,
            feature: "board",
          }).pipe(Effect.flip);
          expect(busy).toMatchObject({ _tag: "InvalidState" });
          expect(busy.message).toContain("Form, Api are still running or waiting on you");
          expect((yield* store.getThread(form.result.threadId)).parked).toBe(false);

          yield* completeTurn(form.session);
          yield* completeTurn(api.session);
          yield* settle;
          const parked = yield* handlers["orchestrator.archiveFeature"]({
            workspaceId,
            feature: "board",
          });
          expect([...parked].toSorted()).toEqual(
            [form.result.threadId, api.result.threadId].toSorted(),
          );
          expect((yield* store.getThread(form.result.threadId)).parked).toBe(true);
          expect((yield* store.getThread(api.result.threadId)).parked).toBe(true);
          expect((yield* store.getThread(other.result.threadId)).parked).toBe(false);
          expect((yield* outboxOf(workspaceId)).notes).toContain(
            "The user archived feature board: its 2 workers are parked. Leave it unless they bring it back.",
          );
          const ledger = yield* orchestration.ledger(workspaceId);
          const board = ledger.features.find((feature) => feature.feature === "board");
          expect(board?.workers.map((worker) => worker.state)).toEqual(["archived", "archived"]);

          for (const [feature, message] of [
            ["board", "has a worker left to archive"],
            ["nobody", "has a worker left to archive"],
            ["  ", "isn't a usable feature name"],
          ] as const) {
            const refused = yield* handlers["orchestrator.archiveFeature"]({
              workspaceId,
              feature,
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
            expect(refused.message).toContain(message);
          }
        }),
      ),
  );

  it.effect(
    "pauses a feature over the RPC: stops its running worker, wakes nobody for it, refuses messages and spawns, and a resume wakes",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* orchestrationHandlers;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          const docs = yield* spawn(session, { feature: "docs", title: "Docs" });
          yield* settle;

          for (const [feature, message] of [
            ["nobody", "No feature is called nobody"],
            ["  ", "isn't a usable feature name"],
          ] as const) {
            const refused = yield* handlers["orchestrator.setFeaturePaused"]({
              workspaceId,
              feature,
              paused: true,
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
            expect(refused.message).toContain(message);
          }

          // Form is still on its brief: pausing stops it.
          const paused = yield* handlers["orchestrator.setFeaturePaused"]({
            workspaceId,
            feature: "Board",
            paused: true,
          });
          expect(paused.pausedFeatures).toEqual(["board"]);
          expect(form.session.interrupts).toBe(1);
          expect(docs.session.interrupts).toBe(0);
          yield* settle;
          expect((yield* outboxOf(workspaceId)).notes).toContain(
            "The user paused feature board, stopping its running worker. Until they resume it, don't message its workers or spawn for it; its news waits for your next digest.",
          );
          const ledger = yield* orchestration.ledger(workspaceId);
          expect(ledger.features.find((each) => each.feature === "board")?.paused).toBe(true);
          expect(ledger.features.find((each) => each.feature === "docs")?.paused).toBeUndefined();
          const cards = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(cards.find((card) => card.feature === "board")?.paused).toBe(true);
          expect(cards.find((card) => card.feature === "docs")?.paused).toBeUndefined();
          // A second pause changes nothing and says nothing more.
          yield* handlers["orchestrator.setFeaturePaused"]({
            workspaceId,
            feature: "board",
            paused: true,
          });
          expect(
            (yield* outboxOf(workspaceId)).notes.filter((note) => note.includes("paused feature")),
          ).toHaveLength(1);

          // The orchestrator can't message its worker or spawn for it, and gets the code.
          const message = yield* session
            .callTool("send_message", { threadId: form.thread.id, text: "Status?" })
            .pipe(Effect.flip);
          expect(message).toMatchObject({ message: expect.stringContaining("feature_paused:") });
          const broadcast = (yield* session.callTool("broadcast_message", {
            text: "main moved",
          })) as { readonly skipped?: ReadonlyArray<{ threadId: string; reason: string }> };
          expect(broadcast.skipped).toEqual([
            expect.objectContaining({
              threadId: form.thread.id,
              reason: expect.stringContaining("feature_paused:"),
            }),
          ]);
          const spawned = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "board",
              title: "Api",
              brief: "Do the api.",
            })
            .pipe(Effect.flip);
          expect(spawned).toMatchObject({
            message: expect.stringContaining("feature_paused: The user paused feature board"),
          });

          // Its worker's report and turn end wake nobody…
          const sentBefore = session.sent.length;
          yield* form.session.callTool("report", { state: "progress", summary: "Halfway." });
          yield* TestClock.adjust("2 minutes");
          yield* settle;
          expect(session.sent).toHaveLength(sentBefore);

          // …while another feature's news does, and carries the pause and the paused feature's row.
          yield* completeTurn(docs.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, sentBefore + 1);
          const digest = session.sent[sentBefore]!.text;
          expect(digest).toContain("- The user paused feature board, stopping its running worker.");
          expect(digest).toMatch(/board \([a-z]+\) · paused by the user:/);
          expect(digest).toContain("Halfway.");
          yield* completeTurn(session);
          yield* settle;

          // Resuming wakes the orchestrator with its word, and messages go through again.
          const resumed = yield* handlers["orchestrator.setFeaturePaused"]({
            workspaceId,
            feature: "board",
            paused: false,
          });
          expect(resumed.pausedFeatures).toBeUndefined();
          expect((yield* store.getWorkspace(workspaceId)).pausedFeatures).toBeUndefined();
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, sentBefore + 2);
          expect(session.sent[sentBefore + 1]!.text).toContain(
            "- The user resumed feature board. Pick it up where it stands",
          );
          yield* completeTurn(session);
          yield* settle;
          expect(
            (yield* orchestration.featureCards(workspaceId)).cards.find(
              (card) => card.feature === "board",
            )?.paused,
          ).toBeUndefined();
          expect(
            yield* session.callTool("send_message", { threadId: form.thread.id, text: "Go on." }),
          ).toMatchObject({ threadId: form.thread.id });
        }),
      ),
  );

  it.effect(
    "renames a feature over the RPC everywhere it keys, refusing a bad or taken name, and tells the orchestrator",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* orchestrationHandlers;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          const api = yield* spawn(session, {
            feature: "board",
            title: "Api",
            branch: "feat/board-api",
          });
          const docs = yield* spawn(session, { feature: "docs", title: "Docs" });
          yield* handlers["orchestrator.setStage"]({ workspaceId, feature: "board", stage: "rc" });
          yield* handlers["orchestrator.setGroup"]({
            workspaceId,
            feature: "board",
            group: "release",
          });
          yield* handlers["orchestrator.setFeaturePaused"]({
            workspaceId,
            feature: "board",
            paused: true,
          });
          // A digest is acknowledged with both features in its snapshot.
          yield* settle;
          const sentBefore = session.sent.length;
          yield* completeTurn(docs.session);
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, sentBefore + 1);
          yield* completeTurn(session);
          yield* settle;
          const before = yield* outboxOf(workspaceId);
          expect(
            Object.values(before.snapshot).filter((entry) => entry.feature === "board"),
          ).toHaveLength(2);
          const cardBefore = (yield* orchestration.featureCards(workspaceId)).cards.find(
            (card) => card.feature === "board",
          )!;

          for (const [feature, to, message] of [
            ["board", "Docs", "A feature called docs exists already"],
            ["board", "  ", "isn't a usable feature name"],
            ["board", "feat/board", "The feature is called board already"],
            ["nobody", "else", "No feature is called nobody"],
          ] as const) {
            const refused = yield* handlers["orchestrator.renameFeature"]({
              workspaceId,
              feature,
              to,
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
            expect(refused.message, to).toContain(message);
          }
          expect((yield* store.getThread(form.result.threadId)).spawnedBy?.feature).toBe("board");

          const renamed = yield* handlers["orchestrator.renameFeature"]({
            workspaceId,
            feature: "board",
            to: "Board V2",
          });
          expect(renamed).toBe("board-v2");

          // Its workers, branches as they were.
          for (const worker of [form, api]) {
            const after = yield* store.getThread(worker.result.threadId);
            expect(after.spawnedBy?.feature).toBe("board-v2");
            expect(after.checkout.branch).toBe(worker.thread.checkout.branch);
          }
          expect((yield* store.getThread(docs.result.threadId)).spawnedBy?.feature).toBe("docs");
          // Its stage, group and pause.
          const state = yield* store.getWorkspace(workspaceId);
          expect(state.stages?.["board"]).toBeUndefined();
          expect(state.stages?.["board-v2"]?.stage).toBe("rc");
          expect(state.groups?.["release"]?.features).toEqual(["board-v2"]);
          expect(state.pausedFeatures).toEqual(["board-v2"]);
          // The outbox's snapshot and the note for the next digest.
          const outbox = yield* outboxOf(workspaceId);
          expect(
            Object.values(outbox.snapshot).filter((entry) => entry.feature === "board-v2"),
          ).toHaveLength(2);
          expect(Object.values(outbox.snapshot).some((entry) => entry.feature === "board")).toBe(
            false,
          );
          expect(outbox.notes).toContain(
            "The user renamed feature board to board-v2. Call it board-v2 from now on, in tools and in memory; its branches keep their names.",
          );
          // Its card under the new name; the old name's card left with no worker, a version on.
          const rows = yield* store.listFeatureCards(workspaceId);
          expect(rows.find((card) => card.feature === "board-v2")).toMatchObject({
            version: cardBefore.version,
            createdAt: cardBefore.createdAt,
            paused: true,
            workers: cardBefore.workers,
          });
          expect(rows.find((card) => card.feature === "board")).toMatchObject({
            version: cardBefore.version + 1,
            workers: [],
          });
          const ledger = yield* orchestration.ledger(workspaceId);
          expect(ledger.features.map((feature) => feature.feature).toSorted()).toEqual([
            "board-v2",
            "docs",
          ]);
          // Paused under its new name as under its old one.
          const refused = yield* session
            .callTool("send_message", { threadId: form.thread.id, text: "Status?" })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({
            message: expect.stringContaining("feature_paused: The user paused feature board-v2"),
          });

          // The next digest tells the new name, with no worker gone or come back.
          yield* handlers["orchestrator.setFeaturePaused"]({
            workspaceId,
            feature: "board-v2",
            paused: false,
          });
          yield* TestClock.adjust("60 seconds");
          yield* waitSent(thread.id, sentBefore + 2);
          const digest = session.sent[sentBefore + 1]!.text;
          expect(digest).toContain("- The user renamed feature board to board-v2.");
          expect(digest).toContain("board-v2 [group release]");
          expect(digest).not.toContain("no longer your worker");
          // The old name is free again.
          yield* completeTurn(session);
          yield* settle;
          expect(
            yield* handlers["orchestrator.renameFeature"]({
              workspaceId,
              feature: "board-v2",
              to: "board",
            }),
          ).toBe("board");
          expect((yield* store.getThread(api.result.threadId)).spawnedBy?.feature).toBe("board");
          const back = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(back.find((card) => card.feature === "board")?.workers).toHaveLength(2);
          expect(back.find((card) => card.feature === "board-v2")?.workers).toEqual([]);
        }),
      ),
  );

  it.effect(
    "a paused feature's worker takes nothing from its queue until the resume, which sends it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          // Queued behind the brief's turn, which is still running.
          expect(
            yield* session.callTool("send_message", {
              threadId: form.thread.id,
              text: "Then the api.",
              mode: "queue",
            }),
          ).toMatchObject({ delivered: "queued" });
          yield* orchestration.setFeaturePaused(workspaceId, "board", true);
          expect(form.session.interrupts).toBe(1);
          yield* settle;
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          expect(yield* allSent(form.thread.id)).toHaveLength(1);

          yield* orchestration.setFeaturePaused(workspaceId, "board", false);
          const sent = yield* sentCount(form.thread.id, 2);
          expect(sent[1]).toContain("Then the api.");
        }),
      ),
  );

  it.effect(
    "a notice to a paused feature's idle worker waits in its queue until the resume, and the user's own word doesn't",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          yield* completeTurn(form.session);
          yield* orchestration.setFeaturePaused(workspaceId, "board", true);
          // Idle with its session open, as a pause leaves it: a monitor's notice is queued, not sent.
          expect(
            yield* runtimes.sendNotice(form.thread.id, "ci:acme/shop#7", {
              text: "CI failed on #7",
            }),
          ).toMatchObject({ queued: true });
          yield* settle;
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          expect(yield* allSent(form.thread.id)).toHaveLength(1);

          yield* orchestration.setFeaturePaused(workspaceId, "board", false);
          const sent = yield* sentCount(form.thread.id, 2);
          expect(sent[1]).toContain("CI failed on #7");
          yield* completeTurn(form.session);

          // The user typing into a paused feature's worker is their own call.
          yield* orchestration.setFeaturePaused(workspaceId, "board", true);
          yield* runtimes.send(form.thread.id, { text: "Look at the form again." });
          expect((yield* sentCount(form.thread.id, 3))[2]).toContain("Look at the form again.");
        }),
      ),
  );

  it.effect("a retried spawn_worker after a pause gets back the worker it made", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const form = yield* spawn(session, {
          feature: "board",
          title: "Form",
          clientRequestId: "form-1",
        });
        yield* orchestration.setFeaturePaused(workspaceId, "board", true);
        expect(
          yield* session.callTool("spawn_worker", {
            project: "shop",
            feature: "board",
            title: "Form",
            brief: "Do the board work.",
            clientRequestId: "form-1",
          }),
        ).toMatchObject({ threadId: form.thread.id, existing: true });
        // A new one is refused.
        const refused = yield* session
          .callTool("spawn_worker", {
            project: "shop",
            feature: "board",
            title: "Api",
            brief: "Do the api.",
            clientRequestId: "api-1",
          })
          .pipe(Effect.flip);
        expect(refused.message).toContain("feature_paused:");
      }),
    ),
  );

  it.effect(
    "a paused feature's worker waiting out a limit isn't resumed until the feature is",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const form = yield* spawn(session, { feature: "board", title: "Form" });
          yield* form.session.emit(
            {
              type: "turnEnd",
              reason: "error",
              error: "You've hit your session limit · resets 12:50pm (Europe/Oslo)",
              failure: { kind: "rateLimit", httpStatus: 429, code: "rate_limit", retryable: true },
            },
            { type: "status", status: "idle" },
          );
          const wait = yield* waitReal(
            "the worker's limit wait",
            store.getThread(form.thread.id).pipe(Effect.map((thread) => thread.limitWait)),
          );
          yield* orchestration.setFeaturePaused(workspaceId, "board", true);
          // Well past its reset, it still waits.
          yield* TestClock.adjust(wait.resumeAt - (yield* Clock.currentTimeMillis) + 3_600_000);
          yield* settle;
          expect(yield* allSent(form.thread.id)).toHaveLength(1);
          expect((yield* store.getThread(form.thread.id)).limitWait).toBeDefined();

          yield* orchestration.setFeaturePaused(workspaceId, "board", false);
          for (let i = 0; i < 20 && (yield* allSent(form.thread.id)).length < 2; i++) {
            yield* TestClock.adjust("1 minute");
            yield* settle;
          }
          expect(yield* allSent(form.thread.id)).toHaveLength(2);
        }),
      ),
  );

  it.effect("a paused feature's worker hears of its dependency's push only on the resume", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "stacked", title: "Stacked" });
        const base = { repo: "acme/app", number: 100 };
        world.prBadges.set("acme/app#100", baseBadge());
        yield* runtimes.updateThread(worker.thread.id, (t) => ({
          ...t,
          boundPr: { repo: "acme/shop", number: 12, monitor: false },
        }));
        yield* publishGit(world, yield* store.getThread(worker.thread.id), { pr: prBadge() });
        yield* session.callTool("depends_on", { threadId: worker.thread.id, pr: "acme/app#100" });
        yield* completeTurn(worker.session);
        yield* orchestration.setFeaturePaused(workspaceId, "stacked", true);
        yield* watchedPr(world, base, baseBadge({ headRefOid: "d2" }));
        yield* settle;
        expect(worker.session.sent).toHaveLength(1);
        yield* orchestration.setFeaturePaused(workspaceId, "stacked", false);
        const pushed = yield* waitSent(worker.thread.id, 2);
        expect(pushed.sent[1]?.text).toContain(
          "acme/app#100, which your acme/shop#12 depends on, got a new push.",
        );
      }),
    ),
  );

  it.effect(
    "a sibling can't message a paused feature's worker, nor can the orchestrator answer for it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const registry = yield* AppToolRegistry;
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* atAutonomy(thread, "full");
          const sender = yield* spawn(session, { feature: "sender" });
          const receiver = yield* spawn(session, { feature: "receiver" });
          yield* completeTurn(receiver.session);
          const hosted = registry
            .forTransport(sender.thread.id, "worker")
            .find((tool) => tool.descriptor.name === "send_message")!;
          yield* orchestration.setFeaturePaused(workspaceId, "receiver", true);
          const refused = yield* hosted
            .run({ threadId: receiver.thread.id, text: "Heads up." })
            .pipe(Effect.flip);
          expect(refused.message).toContain("feature_paused: The user paused feature receiver");
          const answered = yield* session
            .callTool("answer_worker", {
              threadId: receiver.thread.id,
              requestId: "r-1",
              answer: "Yes.",
            })
            .pipe(Effect.flip);
          expect(answered.message).toContain("feature_paused:");
          yield* settle;
          expect(receiver.session.sent).toHaveLength(1);
          // Resumed, the same message goes through.
          yield* orchestration.setFeaturePaused(workspaceId, "receiver", false);
          expect(
            yield* hosted.run({ threadId: receiver.thread.id, text: "Heads up." }),
          ).toMatchObject({ threadId: receiver.thread.id });
        }),
      ),
  );

  it.effect("archiving a paused feature drops its pause", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const form = yield* spawn(session, { feature: "board", title: "Form" });
        yield* spawn(session, { feature: "docs", title: "Docs" });
        yield* orchestration.setFeaturePaused(workspaceId, "docs", true);
        yield* orchestration.setFeaturePaused(workspaceId, "board", true);
        yield* settle;
        expect(yield* orchestration.archiveFeature(workspaceId, "board")).toEqual([form.thread.id]);
        expect((yield* store.getWorkspace(workspaceId)).pausedFeatures).toEqual(["docs"]);
      }),
    ),
  );

  it.effect("a rename waits for a spawn under way, whose worker takes the new name", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        yield* spawn(session, { feature: "board", title: "Form" });
        const second = yield* Effect.forkScoped(
          session.callTool("spawn_worker", {
            project: "shop",
            feature: "board",
            title: "Api",
            brief: "Do the api.",
            branch: "feat/board-api",
            clientRequestId: "api-1",
          }),
        );
        // The spawn has recorded its request, before its worktree: it is under way.
        yield* waitReal(
          "the second spawn under way",
          outboxOf(workspaceId).pipe(
            Effect.map((outbox) => outbox.requests["api-1"] !== undefined),
          ),
        );
        expect(yield* orchestration.renameFeature(workspaceId, "board", "board-v2")).toBe(
          "board-v2",
        );
        const made = (yield* Fiber.join(second)) as { readonly threadId: ThreadId };
        const api = yield* store.getThread(made.threadId);
        expect(api.spawnedBy?.feature).toBe("board-v2");
        expect(api.checkout.branch).toBe("feat/board-api");
        const features = (yield* orchestration.ledger(workspaceId)).features.map((f) => f.feature);
        expect(features).toEqual(["board-v2"]);
      }),
    ),
  );

  it.effect(
    "reads a finished worker with nowhere to open a pull request as delivered, never merged, and costs nothing it wasn't told",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const local = yield* spawn(session, { feature: "local-only", scope: ["src/cart"] });
          const hosted = yield* spawn(session, { feature: "hosted", scope: ["src/api"] });
          const stateOf = (feature: string) =>
            orchestration
              .ledger(workspaceId)
              .pipe(
                Effect.map(
                  (ledger) => ledger.features.find((f) => f.feature === feature)?.workers[0],
                ),
              );
          for (const worker of [local, hosted]) {
            yield* worker.session.callTool("report", { state: "done", summary: "Finished." });
          }
          // Before the first git state nobody knows whether there is a remote.
          expect((yield* stateOf("local-only"))?.state).toBe("done");
          yield* publishGit(world, local.thread, {});
          yield* publishGit(world, hosted.thread, { origin: "acme/shop" });
          expect((yield* stateOf("local-only"))?.state).toBe("delivered");
          expect((yield* stateOf("hosted"))?.state).toBe("done");
          // Reported completion does not end the executing worker or free its slot.
          expect((yield* orchestration.ledger(workspaceId)).budget.liveWorkers).toBe(2);
          yield* completeTurn(local.session);
          expect((yield* stateOf("local-only"))?.state).toBe("delivered");
          expect((yield* stateOf("local-only"))?.status).toBe("idle");
          // Once execution ends with no explicit wait, delivered work frees its slot.
          expect((yield* orchestration.ledger(workspaceId)).budget.liveWorkers).toBe(1);

          // An agent that reports tokens and no cost, as Codex does: no figure, not $0.00.
          yield* hosted.session.emit(
            { type: "usage", tokens: { inputTokens: 5, outputTokens: 5 } },
            { type: "turnEnd", reason: "completed" },
            { type: "status", status: "idle" },
          );
          yield* waitStatus(hosted.thread.id, "idle");
          yield* settle;
          const row = yield* stateOf("hosted");
          expect(row !== undefined && "costUsd" in row).toBe(false);
          expect((yield* orchestration.ledger(workspaceId)).budget.costUsdToday).toBe(0);

          // A claim is weighed against workers still under way: the delivered one's is let go.
          const next = yield* spawn(session, { feature: "next", scope: ["src/cart", "src/api"] });
          expect(next.result.warning).toContain("“Build hosted”");
          expect(next.result.warning).not.toContain("“Build local-only”");
        }),
      ),
  );

  it.effect(
    "streams the ledger: now, then once per burst of changes, and never the same one twice",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const handlers = yield* orchestrationHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* spawn(session, { feature: "board" });
          const seen: Array<OrchestratorLedger> = [];
          const watching = yield* handlers["orchestrator.watchLedger"]({ workspaceId }).pipe(
            Stream.runForEach((ledger) => Effect.sync(() => void seen.push(ledger))),
            Effect.forkScoped,
          );
          yield* waitReal(
            "the first ledger",
            Effect.sync(() => seen.length === 1),
          );
          expect(seen[0]?.features.map((f) => f.feature)).toEqual(["board"]);
          // The subscription's own opening builds a second, which reads the same and goes nowhere.
          yield* TestClock.adjust("300 millis");
          yield* settle;
          expect(seen).toHaveLength(1);

          // A burst is one ledger, 300 ms after its last change.
          yield* orchestration.setStage(workspaceId, { feature: "board", stage: "build" });
          yield* TestClock.adjust("200 millis");
          yield* orchestration.setGroup(workspaceId, { feature: "board", group: "release" });
          yield* TestClock.adjust("200 millis");
          yield* settle;
          expect(seen).toHaveLength(1);
          yield* TestClock.adjust("100 millis");
          yield* waitReal(
            "the ledger after the burst",
            Effect.sync(() => seen.length === 2),
          );
          expect(seen[1]?.features[0]).toMatchObject({
            group: "release",
            stage: { stage: "build", setBy: "user" },
          });
          expect(seen[1]?.groups?.map((g) => g.group)).toEqual(["release"]);

          // A worker's own events count too: its request shows without anyone refetching.
          const worker = (yield* sessionsOf(seen[1]!.features[0]!.workers[0]!.threadId))[0]!;
          yield* worker.emit({
            type: "request",
            request: { kind: "plan", id: "req-1" as RequestId, plan: "1. Ship it." },
          });
          yield* settle;
          yield* TestClock.adjust("300 millis");
          yield* waitReal(
            "the ledger with the request",
            Effect.sync(() => seen.length === 3),
          );
          expect(seen[2]?.features[0]?.workers[0]?.pendingRequests).toMatchObject([
            { kind: "plan", requestId: "req-1" },
          ]);

          // An event that changes nothing the ledger shows sends nothing.
          yield* orchestration.setGroup(workspaceId, { feature: "board", group: "release" });
          yield* TestClock.adjust("300 millis");
          yield* settle;
          expect(seen).toHaveLength(3);

          yield* Fiber.interrupt(watching);
          yield* orchestration.setStage(workspaceId, { feature: "board", stage: "preview" });
          yield* TestClock.adjust("300 millis");
          yield* settle;
          expect(seen).toHaveLength(3);

          const unknown = yield* handlers["orchestrator.watchLedger"]({
            workspaceId: "nowhere" as typeof workspaceId,
          }).pipe(Stream.runCollect, Effect.flip);
          expect(unknown).toMatchObject({ _tag: "NotFound" });
        }),
      ),
  );

  it.effect("streams quiet flags appearing and clearing while orchestration is paused", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const runtimes = yield* ThreadRuntimes;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "quiet-ledger" });
        yield* worker.session.emit({
          type: "backgroundTasks",
          tasks: [
            {
              taskId: "unrelated",
              kind: "subagent",
              description: "background work",
              startedAt: 0,
            },
          ],
        });
        const messageId = "quiet-ledger-reply" as MessageId;
        yield* worker.session.emit({
          type: "chunk",
          messageId,
          chunk: { type: "start", messageId },
        });
        yield* worker.session.emit({
          type: "chunk",
          messageId,
          chunk: {
            type: "tool-input-available",
            toolName: "Bash",
            toolCallId: "quiet-tool",
            input: { command: "long command" },
          },
        });
        yield* settle;
        // Paused with the command running: it runs on to its end, as the pause's stop waits for.
        yield* orchestration.setPaused(workspaceId, true);
        yield* settle;
        const seen: Array<OrchestratorLedger> = [];
        yield* orchestration.watchLedger(workspaceId).pipe(
          Stream.runForEach((ledger) => Effect.sync(() => void seen.push(ledger))),
          Effect.forkScoped,
        );
        yield* waitReal(
          "initial quiet ledger",
          Effect.sync(() => seen.length === 1),
        );
        yield* TestClock.adjust("300 millis");
        yield* settle;
        expect(seen[0]?.features[0]?.workers[0]?.quiet).toBeUndefined();

        yield* TestClock.adjust("10 minutes");
        yield* waitReal(
          "runtime silent tool",
          runtimes.quiet(worker.thread.id).pipe(Effect.map((quiet) => quiet !== undefined)),
        );
        yield* settle;
        yield* TestClock.adjust("300 millis");
        yield* waitReal(
          "ledger silent tool",
          Effect.sync(() => seen.length === 2),
        );
        expect(seen[1]?.features[0]?.workers[0]?.quiet).toMatchObject({
          kind: "toolStalled",
          lastTool: "Bash",
        });

        // Tool output leaves the activity line unchanged, so it supplies no thread.status event.
        yield* worker.session.emit({
          type: "chunk",
          messageId,
          chunk: { type: "tool-output-available", toolCallId: "quiet-tool", output: "done" },
        });
        yield* waitReal(
          "runtime quiet cleared",
          runtimes.quiet(worker.thread.id).pipe(Effect.map((quiet) => quiet === undefined)),
        );
        yield* settle;
        yield* TestClock.adjust("300 millis");
        yield* waitReal(
          "ledger quiet cleared",
          Effect.sync(() => seen.length === 3),
        );
        expect(seen[2]?.features[0]?.workers[0]?.quiet).toBeUndefined();
        expect(session.sent).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "streams an unreported stop after its observer is delayed beyond the idle rebuild",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestratorAcross(world);
          const worker = yield* spawn(session, { feature: "delayed-stop", alsoIn: ["warehouse"] });
          yield* publishGit(world, worker.thread, { pr: prBadge({ checks: "pending" }) });
          yield* orchestration.setPaused(workspaceId, true);
          const release = yield* stallGit(world, worker.thread);
          // Keep that signal handler blocked, while allowing the ledger's separate reads through.
          world.stall = undefined;
          const seen: Array<OrchestratorLedger> = [];
          yield* orchestration.watchLedger(workspaceId).pipe(
            Stream.runForEach((ledger) => Effect.sync(() => void seen.push(ledger))),
            Effect.forkScoped,
          );
          yield* waitReal(
            "initial delayed-stop ledger",
            Effect.sync(() => seen.length === 1),
          );
          yield* TestClock.adjust("300 millis");
          yield* settle;
          expect(seen[0]?.features[0]?.workers[0]?.quiet).toBeUndefined();
          yield* worker.session.completeTurn();
          yield* waitStatus(worker.thread.id, "idle");
          yield* TestClock.adjust("300 millis");
          yield* settle;
          // The idle status was already consumed; the queued observer has not persisted the stop.
          expect((yield* outboxOf(workspaceId)).workers[worker.thread.id]?.quiet).toBeUndefined();
          expect(seen.at(-1)?.features[0]?.workers[0]?.quiet).toBeUndefined();
          yield* release;
          yield* waitReal(
            "persisted delayed stop",
            outboxOf(workspaceId).pipe(
              Effect.map((outbox) => outbox.workers[worker.thread.id]?.quiet?.kind === "turnEnded"),
            ),
          );
          yield* settle;
          yield* TestClock.adjust("300 millis");
          yield* waitReal(
            "subscribed delayed stop",
            Effect.sync(() => seen.at(-1)?.features[0]?.workers[0]?.quiet?.kind === "turnEnded"),
          );
          expect(session.sent).toHaveLength(1);
        }),
      ),
  );

  it.effect("starts a handoff from the RPC as the user's", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const handlers = yield* orchestrationHandlers;
        const { session, thread, workspaceId } = yield* openOrchestrator(world);
        expect((yield* handlers["orchestrator.handoff"]({ workspaceId })).id).toBe(thread.id);
        yield* waitSent(thread.id, 2);
        expect(session.sent[1]?.text).toContain("The user asked for a handoff");
        expect((yield* outboxOf(workspaceId)).handoff).toMatchObject({
          reason: "user",
          phase: "checkpoint",
        });
        const twice = yield* handlers["orchestrator.handoff"]({ workspaceId }).pipe(Effect.flip);
        expect(twice).toMatchObject({ _tag: "InvalidState" });
        const nowhere = yield* handlers["orchestrator.handoff"]({
          workspaceId: "nowhere" as typeof workspaceId,
        }).pipe(Effect.flip);
        expect(nowhere).toMatchObject({ _tag: "NotFound" });
      }),
    ),
  );

  it.effect("saves, edits and removes workspaces", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId, project } = yield* openOrchestrator(world);
        const other = yield* store.ensureProject({
          root: makeRepo(nodePath.join(world.dir, "other")),
          name: "other",
        });

        const widened = yield* orchestration.saveWorkspace({
          id: workspaceId,
          name: "Shop platform",
          projectIds: [project.id, other.id],
          homeProjectId: project.id,
        });
        // An edit never touches the slot, and the orchestrator is given the new repo to read.
        expect(widened.workspace).toMatchObject({
          name: "Shop platform",
          orchestratorThreadId: thread.id,
        });
        expect((yield* store.getThread(thread.id)).additionalDirectories).toEqual([other.root]);
        const moved = yield* orchestration
          .saveWorkspace({
            id: workspaceId,
            name: "Shop platform",
            projectIds: [project.id, other.id],
            homeProjectId: other.id,
          })
          .pipe(Effect.flip);
        expect(moved.message).toContain("home");
        // A repo that leaves takes the orchestrator's grant of its folder with it.
        const narrowed = yield* orchestration.saveWorkspace({
          id: workspaceId,
          name: "Shop platform",
          projectIds: [project.id],
          homeProjectId: project.id,
        });
        expect(narrowed.workspace.projectIds).toEqual([project.id]);
        expect((yield* store.getThread(thread.id)).additionalDirectories).toEqual([]);
        expect((yield* store.listProjects).map((p) => p.id)).toContain(other.id);

        const charter = { ...DEFAULT_CHARTER, maxConcurrentWorkers: 2 };
        expect((yield* orchestration.setCharter(workspaceId, charter)).charter).toEqual(charter);
        expect((yield* orchestration.ledger(workspaceId)).budget).toEqual({
          liveWorkers: 0,
          maxConcurrentWorkers: 2,
          costUsdToday: 0,
        });

        // A dream running in the workspace, however it was started, closes with it, but not when
        // the removal is refused for the orchestrator that is still open.
        const dreamer = "t-dreamer" as ThreadId;
        yield* store.insertThread({ ...thread, id: dreamer, role: "dream" });
        yield* store.putDream({
          id: "dream-0001" as DreamId,
          workspaceId,
          kind: "dream",
          mode: "review",
          status: "running",
          threadId: dreamer,
          inputs: { memoryVersion: "0001", threadIds: [], agentSessions: [] },
          model: { agent: "claude", model: "default" },
          outputDir: nodePath.join(world.dir, "dream-0001"),
          createdAt: 1,
        });
        // One that finished and waits on review goes the same way.
        const reviewed = "t-reviewed" as ThreadId;
        yield* store.insertThread({ ...thread, id: reviewed, role: "dream" });
        yield* store.putDream({
          id: "dream-0002" as DreamId,
          workspaceId,
          kind: "dream",
          mode: "review",
          status: "completed",
          threadId: reviewed,
          inputs: { memoryVersion: "0001", threadIds: [], agentSessions: [] },
          model: { agent: "claude", model: "default" },
          outputDir: nodePath.join(world.dir, "dream-0002"),
          createdAt: 2,
        });
        const held = yield* orchestration.removeWorkspace(workspaceId).pipe(Effect.flip);
        expect(held).toMatchObject({ _tag: "InvalidState" });
        expect((yield* store.listThreads).map((t) => t.id)).toEqual(
          expect.arrayContaining([dreamer, reviewed]),
        );
        yield* runtimes.close(thread.id);
        yield* settle;
        yield* orchestration.removeWorkspace(workspaceId);
        const left = (yield* store.listThreads).map((t) => t.id);
        expect(left).not.toContain(dreamer);
        expect(left).not.toContain(reviewed);
        expect(yield* orchestration.listWorkspaces).toEqual([]);
        // What the orchestrator learned is the user's: removing the workspace leaves it on disk.
        expect(fs.readdirSync(nodePath.join(world.dir, "memory", workspaceId))).toContain(
          "versions",
        );
      }),
    ),
  );
});
