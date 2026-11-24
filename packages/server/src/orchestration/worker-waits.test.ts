import { describe, expect, it } from "@effect/vitest";
import type { WaitId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadWaits } from "../waits/service.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  spawn,
  stopSilently,
  waitSent,
  withServer,
  type World,
} from "./test-harness.ts";
import { nextDigest, withWorker } from "./worker-question-harness.ts";

// An orchestrator keeps the user's Waiting on you true across its workspace: it lists every
// thread's items there, its workers' live and archived, and edits, withdraws, marks done or
// deletes any of them, the user's own included, each change recorded. Nothing outside its
// workspace: a sibling worker or another workspace's orchestrator is refused.

const otherOrchestrator = (other: World) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: other.repo, name: "other" });
    const state = yield* orchestration.saveWorkspace({
      name: "other",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return session;
  });

describe("an orchestrator and its workspace's Waiting on you", () => {
  it.effect("withdraws its own worker's item, which the worker hears as withdrawn", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const other = yield* makeWorld;
      return yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const waits = yield* ThreadWaits;
          const { session, thread, worker } = yield* withWorker(world);
          const sibling = yield* spawn(session, { feature: "mail", title: "Mail trigger" });
          yield* completeTurn(session);
          const elsewhere = yield* otherOrchestrator(other);
          const { id } = (yield* worker.session.callTool("wait_on_user", {
            kind: "action",
            title: "Run assume example-prod",
          })) as { id: WaitId };
          const workerId = worker.thread.id;

          // Neither a sibling worker nor another workspace's orchestrator may touch it.
          for (const caller of [sibling.session, elsewhere]) {
            for (const [name, input] of [
              ["resolve_wait", { id, threadId: workerId }],
              ["resolve_wait", { id, threadId: workerId, ending: "deleted" }],
              ["list_waits", { threadId: workerId }],
              ["wait_on_user", { id, threadId: workerId, kind: "action", title: "Moved" }],
            ] as const) {
              const refused = yield* caller.callTool(name, input).pipe(Effect.flip);
              if (caller === elsewhere) {
                expect(String(refused)).toContain("only that workspace's orchestrator");
              }
            }
          }
          expect(yield* store.getWait(workerId, id)).toMatchObject({
            title: "Run assume example-prod",
          });
          expect((yield* store.getWait(workerId, id)).resolvedAt).toBeUndefined();
          // And its workspace-wide list holds nothing of this workspace.
          expect(yield* elsewhere.callTool("list_waits", {})).toEqual({ waits: [] });

          // Its own orchestrator reads it without marking it heard for the worker.
          expect(yield* session.callTool("list_waits", { threadId: workerId })).toMatchObject({
            waits: [{ id, state: "open" }],
          });
          expect(
            yield* session.callTool("resolve_wait", {
              id,
              threadId: workerId,
              note: "the deploy job runs it now",
            }),
          ).toEqual({
            id,
            threadId: workerId,
            resolvedBy: "agent",
            ending: "withdrawn",
            resolvedByThread: thread.id,
          });
          expect(yield* store.getWait(workerId, id)).toMatchObject({
            ending: "withdrawn",
            resolverThread: thread.id,
            note: "the deploy job runs it now",
          });
          expect(
            yield* session.callTool("list_waits", { threadId: workerId, state: "all" }),
          ).toMatchObject({ waits: [{ id, state: "withdrawn", resolvedByThread: thread.id }] });

          // The worker didn't withdraw it, so its next message tells it.
          const drafted = yield* waits.draftNote(workerId, []);
          expect(drafted?.news).toMatchObject([{ id, ending: "withdrawn" }]);
          expect(drafted?.note).toContain("the deploy job runs it now");
        }),
      );
    }),
  );

  it.effect("lists, resolves and deletes the items of an archived worker and the user's own", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      return yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const waits = yield* ThreadWaits;
          const { session, thread, worker } = yield* withWorker(world);
          const workerId = worker.thread.id;
          const { id: stale } = (yield* worker.session.callTool("wait_on_user", {
            kind: "action",
            title: "Rebuild the cluster",
          })) as { id: WaitId };
          const { item: theirs } = yield* waits.put(
            workerId,
            { kind: "review", title: "Read the rollout notes" },
            "user",
          );
          const { id: own } = (yield* session.callTool("wait_on_user", {
            kind: "draft",
            title: "Mail to the team",
          })) as { id: WaitId };
          yield* worker.session.callTool("report", { state: "done", summary: "Done." });
          yield* completeTurn(worker.session);

          // Archiving it says what it leaves on the user's list.
          const archived = (yield* session.callTool("archive_thread", {
            threadId: workerId,
          })) as { openWaits?: ReadonlyArray<{ id: string }>; note?: string };
          expect(archived.openWaits?.map((item) => item.id)).toEqual([stale, theirs.id]);
          expect(archived.note).toContain("resolve_wait");

          // Its own list is the whole workspace's, each row naming where it lives.
          expect(yield* session.callTool("list_waits", {})).toMatchObject({
            waits: [
              {
                id: stale,
                threadId: workerId,
                thread: "Cart API",
                archived: true,
                source: "agent",
              },
              { id: theirs.id, threadId: workerId, archived: true, source: "user" },
              { id: own, threadId: thread.id, source: "agent" },
            ],
          });
          expect(
            (
              (yield* session.callTool("list_waits", { threadId: thread.id })) as {
                waits: ReadonlyArray<{ id: string }>;
              }
            ).waits.map((row) => row.id),
          ).toEqual([own]);

          // The user's own item it may mark done; the stale one it deletes, kept as a record.
          yield* session.callTool("resolve_wait", {
            id: theirs.id,
            threadId: workerId,
            ending: "done",
          });
          expect(
            yield* session.callTool("resolve_wait", {
              id: stale,
              threadId: workerId,
              ending: "deleted",
              note: "superseded",
            }),
          ).toMatchObject({ id: stale, ending: "withdrawn", deleted: true });
          const tombstone = yield* store.getWait(workerId, stale);
          expect(tombstone).toMatchObject({
            title: "Rebuild the cluster",
            ending: "withdrawn",
            resolverThread: thread.id,
            note: "superseded",
            history: [{ change: "deleted", by: "agent", thread: thread.id }],
          });
          expect(tombstone.deletedAt).toBeDefined();

          // Deleted is out of every list the user and the agents read, and of the open count.
          expect(
            (
              (yield* session.callTool("list_waits", { state: "all" })) as {
                waits: ReadonlyArray<{ id: string; state: string }>;
              }
            ).waits.map((row) => [row.id, row.state]),
          ).toEqual([
            [theirs.id, "done"],
            [own, "open"],
          ]);
          expect(yield* store.listWaits(workerId, "all")).toMatchObject([{ id: theirs.id }]);
          expect(yield* session.callTool("list_waits", { state: "deleted" })).toMatchObject({
            waits: [{ id: stale, state: "deleted", history: [{ change: "deleted" }] }],
          });
          // Deleting again changes nothing.
          yield* session.callTool("resolve_wait", {
            id: stale,
            threadId: workerId,
            ending: "deleted",
          });
          expect(yield* store.getWait(workerId, stale)).toEqual(tombstone);
        }),
      );
    }),
  );

  it.effect("edits a worker's item in place, recording what it said, and the worker hears", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      return yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const waits = yield* ThreadWaits;
          const { session, thread, worker } = yield* withWorker(world);
          const workerId = worker.thread.id;
          const { id } = (yield* worker.session.callTool("wait_on_user", {
            kind: "action",
            title: "Run the migration",
            content: "On the staging box.",
          })) as { id: WaitId };
          const before = yield* store.getWait(workerId, id);

          // Without an id it would add to another thread's list, which it may not.
          yield* session
            .callTool("wait_on_user", { threadId: workerId, kind: "action", title: "New" })
            .pipe(Effect.flip);

          expect(
            yield* session.callTool("wait_on_user", {
              threadId: workerId,
              id,
              kind: "review",
              title: "Review the migration plan",
              link: "https://example.com/plan",
            }),
          ).toMatchObject({ id, threadId: workerId });
          const after = yield* store.getWait(workerId, id);
          expect(after).toMatchObject({
            id,
            kind: "review",
            title: "Review the migration plan",
            link: "https://example.com/plan",
            source: "agent",
            createdAt: before.createdAt,
            messageId: before.messageId,
            history: [
              {
                change: "edited",
                by: "agent",
                thread: thread.id,
                from: { kind: "action", title: "Run the migration", body: "On the staging box." },
              },
            ],
          });
          expect(after.body).toBeUndefined();
          expect(yield* store.listWaits(workerId)).toHaveLength(1);

          const drafted = yield* waits.draftNote(workerId, []);
          expect(drafted?.note).toContain("Your orchestrator edited");
          expect(drafted?.note).toContain("Review the migration plan");
        }),
      );
    }),
  );

  it.effect("counts an archived worker's open items in the digest, flagged likely stale", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      return yield* withServer(
        world,
        Effect.gen(function* () {
          const { session, worker } = yield* withWorker(world);
          const live = yield* spawn(session, { feature: "mail", title: "Mail trigger" });
          yield* completeTurn(session);
          yield* worker.session.callTool("wait_on_user", {
            kind: "action",
            title: "Rebuild the cluster",
          });
          yield* live.session.callTool("wait_on_user", { kind: "action", title: "Sign the form" });
          yield* stopSilently(worker.session);
          yield* session.callTool("archive_thread", { threadId: worker.thread.id });
          yield* live.session.callTool("report", { state: "progress", summary: "Halfway." });

          const digest = yield* nextDigest(session);
          expect(digest).toContain("Waiting on the user: 2 steps to take");
          expect(digest).toContain("1 is from an archived or merged thread, likely stale");
          expect(digest).toMatch(
            /- action "Rebuild the cluster" in "Cart API" \[thread [^\]]+\] \(w-[^)]+\), \d+m, archived: likely stale/,
          );
          expect(digest).not.toContain('"Sign the form" in');
        }),
      );
    }),
  );
});
