import { describe, expect, it } from "@effect/vitest";
import { type ThreadId, type WaitId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { threadWaitHandlers } from "../rpc/handlers/thread-waits.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadWaits } from "./service.ts";

// How a Waiting on you item ends: done or dismissed by the user, or withdrawn by its thread. Each
// is stored and listed as itself, and the thread that added it hears which.

const createThread = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  return yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
});

const runTool = (threadId: ThreadId, name: string, input: unknown) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tool = registry.forThread(threadId).find((t) => t.descriptor.name === name);
    if (tool === undefined) return yield* Effect.die(`no tool ${name}`);
    return yield* tool.run(input);
  });

const add = (threadId: ThreadId, title: string) =>
  runTool(threadId, "wait_on_user", { kind: "action", title }).pipe(
    Effect.map((r) => (r as { id: WaitId }).id),
  );

const listed = (threadId: ThreadId) =>
  runTool(threadId, "list_waits", { state: "all" }).pipe(
    Effect.map(
      (r) => (r as { waits: ReadonlyArray<{ id: WaitId; state: string; note?: string }> }).waits,
    ),
  );

describe("Waiting on you endings", () => {
  it.effect(
    "the user's Dismiss is recorded as dismissed, not done, and the agent hears which",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const waits = yield* ThreadWaits;
        const handlers = yield* threadWaitHandlers;
        const thread = yield* createThread;
        const done = yield* add(thread.id, "Approve in the portal");
        const dismissed = yield* add(thread.id, "Run assume example-prod");

        yield* handlers["thread.resolveWait"]({ threadId: thread.id, id: done });
        const item = yield* handlers["thread.resolveWait"]({
          threadId: thread.id,
          id: dismissed,
          dismiss: true,
          note: "  the deploy job does it now ‮",
        });
        expect(item).toMatchObject({
          resolvedBy: "user",
          ending: "dismissed",
          note: "the deploy job does it now",
        });
        expect((yield* store.getWait(thread.id, done)).ending).toBeUndefined();

        // Its chip says it was dismissed, a key a client that knows only `done` can ignore.
        const parts = (yield* store.listMessages(thread.id)).flatMap((m) => m.parts);
        expect(parts.find((p) => p.type === "data-wait" && p.id === dismissed)).toMatchObject({
          data: { state: "done", ending: "dismissed" },
        });

        // The agent's next message tells the two apart.
        const drafted = yield* waits.draftNote(thread.id, []);
        expect(drafted?.news).toMatchObject([
          { id: done, resolvedBy: "user" },
          { id: dismissed, resolvedBy: "user", ending: "dismissed" },
        ]);
        expect(drafted?.news[0]?.ending).toBeUndefined();
        expect(drafted?.note).toContain("the deploy job does it now");

        // resolve_wait and list_waits answer how it ended.
        expect(yield* runTool(thread.id, "resolve_wait", { id: dismissed })).toMatchObject({
          resolvedBy: "user",
          ending: "dismissed",
        });
        expect(yield* listed(thread.id)).toMatchObject([
          { id: done, state: "done" },
          { id: dismissed, state: "dismissed", note: "the deploy job does it now" },
        ]);

        // Undo reopens it with no ending left on it.
        const reopened = yield* handlers["thread.resolveWait"]({
          threadId: thread.id,
          id: dismissed,
          undo: true,
        });
        expect(reopened.resolvedAt).toBeUndefined();
        expect(reopened.ending).toBeUndefined();
        expect(reopened.note).toBeUndefined();
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("the agent withdraws its own item: listed as withdrawn, and no news to it", () =>
    Effect.gen(function* () {
      const waits = yield* ThreadWaits;
      const thread = yield* createThread;
      const id = yield* add(thread.id, "Send the rollout note");
      expect(
        yield* runTool(thread.id, "resolve_wait", {
          id,
          ending: "withdrawn",
          note: "the rollout moved",
        }),
      ).toEqual({ id, resolvedBy: "agent", ending: "withdrawn" });
      expect(yield* listed(thread.id)).toMatchObject([
        { id, state: "withdrawn", resolvedBy: "agent", note: "the rollout moved" },
      ]);
      expect(yield* waits.draftNote(thread.id, [])).toBeUndefined();

      // A plain resolve_wait still marks it done, as before endings.
      const other = yield* add(thread.id, "Approve the release");
      expect(yield* runTool(thread.id, "resolve_wait", { id: other })).toEqual({
        id: other,
        resolvedBy: "agent",
        ending: "done",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a thread that isn't its orchestrator can't resolve or read another's items", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const thread = yield* createThread;
      const stranger = yield* createThread;
      const id = yield* add(thread.id, "Run assume example-prod");
      for (const [name, input] of [
        ["resolve_wait", { id, threadId: thread.id }],
        ["list_waits", { threadId: thread.id }],
      ] as const) {
        // Bound without `threadId`, so naming one is refused rather than dropped.
        const refused = yield* runTool(stranger.id, name, input).pipe(Effect.flip);
        expect(refused.message).toContain("threadId");
      }
      expect((yield* store.getWait(thread.id, id)).resolvedAt).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
