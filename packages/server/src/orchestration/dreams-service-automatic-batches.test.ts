// Automatic Dream batches: retries, admission refusals, races and the threshold.
import { describe, expect, it } from "@effect/vitest";
import { type Dream, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { emptyOutbox, emptyWorkerMemo, encodeOutbox } from "./outbox.ts";
import { Orchestration } from "./service.ts";
import { completeTurn, openOrchestrator, settle, waitReal, waitSent } from "./test-harness.ts";
import {
  inDreams,
  writeOutput,
  startDream,
  finishDream,
  completeConversation,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("automatic Dream integration", () => {
  for (const configuration of [
    "enable",
    "manual-edit",
    "automatic-edit-success",
    "automatic-edit-failed",
    "automatic-edit-canceled",
  ] as const)
    it.effect(`observes the running Dream across a fresh threshold epoch (${configuration})`, () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId, project } = yield* openOrchestrator(world);
          const store = yield* ThreadStore;
          const dreams = yield* Dreams;
          const orchestration = yield* Orchestration;
          const state = yield* store.getWorkspace(workspaceId);
          const automatic = configuration.startsWith("automatic");
          let first: Dream;
          let session: FakeSession;
          if (automatic) {
            yield* orchestration.setCharter(workspaceId, {
              ...state.charter,
              automaticDreamThreshold: 1,
            });
            yield* completeConversation(project.root);
            first = yield* waitReal(
              "first automatic run",
              store.listDreams(workspaceId).pipe(Effect.map((rows) => rows[0])),
            );
            session = yield* waitSent(first.threadId as ThreadId, 1);
            yield* dreams.automaticStatus(workspaceId);
          } else {
            if (configuration === "manual-edit")
              yield* orchestration.setCharter(workspaceId, {
                ...state.charter,
                automaticDreamThreshold: 2,
              });
            ({ dream: first, session } = yield* startDream(workspaceId));
          }
          const previous = yield* store.getAutomaticDreamState(workspaceId);
          const threshold = automatic ? 2 : 1;
          yield* orchestration.setCharter(workspaceId, {
            ...state.charter,
            automaticDreamThreshold: threshold,
          });
          const baseline = yield* store.getAutomaticDreamState(workspaceId);
          expect(baseline?.observedDreamId).toBe(first.id);
          expect(baseline?.epoch).not.toBe(previous?.epoch);
          expect(baseline?.completed).toBe(0);
          expect(baseline?.lastAttemptId).toBeUndefined();
          for (let completion = 0; completion < threshold; completion++)
            yield* completeConversation(project.root);
          yield* waitReal(
            "ready in new epoch",
            dreams
              .automaticStatus(workspaceId)
              .pipe(
                Effect.map(
                  (status) => status.completed === threshold && status.detail.includes("running"),
                ),
              ),
          );
          if (configuration.endsWith("canceled")) yield* dreams.cancel(first.id);
          else if (configuration.endsWith("failed")) yield* finishDream(first, session, "failed");
          else {
            writeOutput(first, { "MEMORY.md": "# Synthetic threshold transition candidate\n" });
            yield* finishDream(first, session, "completed");
          }
          if (configuration.endsWith("failed") || configuration.endsWith("canceled")) {
            yield* waitReal(
              "terminal failure accounted",
              store
                .getAutomaticDreamState(workspaceId)
                .pipe(Effect.map((schedule) => schedule?.lastFailureDreamId === first.id)),
            );
            expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
            yield* dreams.automaticConfigurationChanged;
            expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
            const fake = yield* FakeAgentControl;
            expect(
              fake.sessions.filter((opened) => opened.options.audience === "dream"),
            ).toHaveLength(1);
          } else {
            const next = yield* waitReal(
              "fresh new-epoch batch started",
              store
                .listDreams(workspaceId)
                .pipe(Effect.map((rows) => rows.find((row) => row.id !== first.id))),
            );
            expect(next.mode).toBe("review");
            expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
            expect(yield* store.listDreams(workspaceId)).toHaveLength(2);
          }
        }),
      ),
    );
  it.effect("retries a ready batch once after the running Dream succeeds", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const { workspaceId, project } = yield* openOrchestrator(world);
        const store = yield* ThreadStore;
        const dreams = yield* Dreams;
        const orchestration = yield* Orchestration;
        const state = yield* store.getWorkspace(workspaceId);
        yield* orchestration.setCharter(workspaceId, {
          ...state.charter,
          automaticDreamThreshold: 1,
        });
        yield* completeConversation(project.root);
        const first = yield* waitReal(
          "automatic start",
          store.listDreams(workspaceId).pipe(Effect.map((rows) => rows[0])),
        );
        const session = yield* waitSent(first.threadId as ThreadId, 1);
        yield* completeConversation(project.root);
        yield* waitReal(
          "ready while running",
          dreams.automaticStatus(workspaceId).pipe(Effect.map((status) => status.completed === 1)),
        );
        writeOutput(first, { "MEMORY.md": "# Synthetic completed candidate\n" });
        yield* finishDream(first, session, "completed");
        yield* settle;
        expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
        const rows = yield* store.listDreams(workspaceId);
        expect(rows).toHaveLength(2);
        const next = rows.find((row) => row.id !== first.id)!;
        expect(next.status).toBe("running");
        expect(next.mode).toBe("review");
        yield* dreams.automaticConfigurationChanged;
        yield* settle;
        expect(yield* store.listDreams(workspaceId)).toHaveLength(2);
      }),
    ),
  );
  for (const boundary of ["pause", "held", "provider", "edit", "claim"] as const)
    it.effect(
      `preserves only its own earned batch after final ${boundary} admission refusal`,
      () => {
        let preparations = 0;
        return inDreams(
          (world) =>
            Effect.gen(function* () {
              const { workspaceId, project } = yield* openOrchestrator(world);
              const store = yield* ThreadStore;
              const dreams = yield* Dreams;
              const orchestration = yield* Orchestration;
              const fake = yield* FakeAgentControl;
              const state = yield* store.getWorkspace(workspaceId);
              yield* orchestration.setCharter(workspaceId, {
                ...state.charter,
                automaticDreamThreshold: 1,
              });
              const conversation = yield* completeConversation(project.root);
              yield* settle;
              const status = yield* dreams.automaticStatus(workspaceId);
              expect(status.completed).toBe(boundary === "edit" || boundary === "claim" ? 0 : 1);
              expect(yield* store.listDreams(workspaceId)).toHaveLength(0);
              expect(
                fake.sessions.filter((session) => session.options.audience === "dream"),
              ).toHaveLength(0);
              if (boundary === "edit") expect(status.threshold).toBe(2);
              if (boundary === "claim")
                expect((yield* store.getAutomaticDreamState(workspaceId))?.lastAttemptId).toBe(
                  "newer-uncertain-claim",
                );
              if (boundary === "pause") {
                expect(status.detail).toContain("resume");
                yield* (yield* ThreadRuntimes).markCompleted(conversation.id, "agent");
                yield* settle;
                expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(1);
                yield* orchestration.setPaused(workspaceId, false);
                const resumed = yield* waitReal(
                  "restored batch on resume",
                  store.listDreams(workspaceId).pipe(Effect.map((rows) => rows[0])),
                );
                expect(resumed.mode).toBe("review");
                expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
              }
            }),
          {
            beforePrepare: (id) =>
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                if (preparations++ > 0) return;
                expect((yield* store.getAutomaticDreamState(id))?.lastAttemptId).toBeDefined();
                if (boundary === "pause")
                  yield* store.updateWorkspace(id, (state) => ({
                    ...state,
                    paused: { at: 123, reason: "user" },
                  }));
                if (boundary === "held")
                  yield* store.putOutbox(
                    id,
                    encodeOutbox({
                      ...emptyOutbox,
                      workers: { synthetic: { ...emptyWorkerMemo(0), userIntervened: true } },
                    }),
                  );
                if (boundary === "provider") {
                  const settings = yield* store.getSettings;
                  yield* store.putSettings({
                    ...settings,
                    agents: {
                      ...settings.agents,
                      defaultModel: { agent: "claude", model: "synthetic-unavailable" },
                    },
                  });
                }
                if (boundary === "edit")
                  yield* store.updateWorkspace(id, (state) => ({
                    ...state,
                    charter: { ...state.charter, automaticDreamThreshold: 2 },
                  }));
                if (boundary === "claim")
                  yield* store.updateAutomaticDreamState(id, (state) => ({
                    ...state,
                    lastAttemptId: "newer-uncertain-claim",
                  }));
              }).pipe(Effect.orDie),
          },
        );
      },
    );
  it.effect(
    "races manual and automatic starts under the same lock, defaults review and waits after cancel",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId, project } = yield* openOrchestrator(world);
          const dreams = yield* Dreams;
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const state = yield* store.getWorkspace(workspaceId);
          yield* orchestration.setCharter(workspaceId, {
            ...state.charter,
            automaticDreamThreshold: 1,
          });
          const conversation = yield* runtimes.create({
            projectRoot: project.root,
            checkout: { kind: "main", path: project.root },
            model: { agent: "claude", model: "default" },
            mode: "default",
            input: { text: "Synthetic conversation to consolidate." },
          });
          yield* completeTurn(yield* waitSent(conversation.id, 1));
          // A completed agent reply is not a completed conversation.
          expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
          yield* Effect.all(
            [
              runtimes.markCompleted(conversation.id, "user"),
              dreams.start({ workspaceId, kind: "dream" }).pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          );
          yield* settle;
          const rows = yield* store.listDreams(workspaceId);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.mode).toBe("review");
          expect(rows[0]?.status).toBe("running");
          expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
          const another = yield* runtimes.create({
            projectRoot: project.root,
            checkout: { kind: "main", path: project.root },
            model: { agent: "claude", model: "default" },
            mode: "default",
            input: { text: "Another synthetic completion while Dream runs." },
          });
          yield* completeTurn(yield* waitSent(another.id, 1));
          yield* runtimes.markCompleted(another.id, "user");
          yield* waitReal(
            "deferred while Dream runs",
            dreams
              .automaticStatus(workspaceId)
              .pipe(Effect.map((s) => s.completed === 1 && s.detail.includes("running"))),
          );
          expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
          yield* dreams.cancel(rows[0]!.id);
          yield* settle;
          expect((yield* dreams.automaticStatus(workspaceId)).detail).toContain("cancelled");
          expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
          yield* dreams.automaticConfigurationChanged;
          yield* runtimes.markCompleted(conversation.id, "agent");
          yield* settle;
          expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "launches at the threshold through the real Dream service and resets on a manual start",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId, project } = yield* openOrchestrator(world);
          const dreams = yield* Dreams;
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const state = yield* store.getWorkspace(workspaceId);
          yield* orchestration.setCharter(workspaceId, {
            ...state.charter,
            automaticDreamThreshold: 2,
          });
          const complete = Effect.gen(function* () {
            const conversation = yield* runtimes.create({
              projectRoot: project.root,
              checkout: { kind: "main", path: project.root },
              model: { agent: "claude", model: "default" },
              mode: "default",
              input: { text: "Synthetic consolidation input." },
            });
            yield* completeTurn(yield* waitSent(conversation.id, 1));
            yield* runtimes.markCompleted(conversation.id, "user");
            return conversation;
          });
          yield* complete;
          yield* waitReal(
            "one completion",
            dreams.automaticStatus(workspaceId).pipe(Effect.map((s) => s.completed === 1)),
          );
          const manual = yield* dreams.start({ workspaceId, kind: "dream" });
          expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
          yield* dreams.cancel(manual.id);
          yield* settle;
          yield* complete;
          yield* complete;
          const automatic = yield* waitReal(
            "automatic Dream started",
            store
              .listDreams(workspaceId)
              .pipe(Effect.map((rows) => rows.find((d) => d.id !== manual.id))),
          );
          expect(automatic.mode).toBe("review");
          expect(automatic.adoptedVersion).toBeUndefined();
          yield* waitSent(automatic.threadId as ThreadId, 1);
          expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(0);
        }),
      ),
  );
});
