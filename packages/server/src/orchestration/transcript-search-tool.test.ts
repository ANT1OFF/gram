import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  makeWorld,
  openOrchestrator,
  spawn,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const say = (threadId: ThreadId, id: string, role: "user" | "assistant", text: string) =>
  Effect.flatMap(ThreadStore, (store) =>
    store.upsertMessage(threadId, { id, role, parts: [{ type: "text", text }] } as never),
  );

interface Hits {
  readonly hits: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly part: string;
    readonly seq: number;
    readonly role: string;
    readonly snippet: string;
    readonly text?: string;
    readonly yours?: true;
  }>;
  readonly truncated?: true;
}

describe("search_transcripts", () => {
  it.effect("is bound for an orchestrator, its workers and a dream, not a plain thread", () =>
    inServer(() =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        const has = (audience: "plain" | "orchestrator" | "worker" | "dream") =>
          registry
            .forThread("t" as ThreadId, audience)
            .some((tool) => tool.descriptor.name === "search_transcripts");
        expect(has("orchestrator")).toBe(true);
        expect(has("worker")).toBe(true);
        expect(has("dream")).toBe(true);
        expect(has("plain")).toBe(false);
      }),
    ),
  );

  it.effect("answers from the caller's workspace only, scrubbed, with where each match sits", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session, thread, project } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "billing" });
        yield* say(thread.id, "o-1", "user", "We decided the invoices queue retries three times.");
        yield* say(
          worker.thread.id,
          "w-1",
          "assistant",
          "The invoices queue flaked under load; token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 was in the log.",
        );
        // A thread outside the workspace that says the same.
        const outsider = {
          ...(yield* store.getThread(worker.thread.id)),
          id: "outsider" as ThreadId,
          title: "Elsewhere",
          projectId: project.id,
        } as Thread;
        const { workspaceId: _ws, spawnedBy: _by, ...plain } = outsider;
        yield* store.insertThread(plain);
        yield* say(plain.id, "x-1", "user", "invoices queue somewhere else");

        const all = (yield* session.callTool("search_transcripts", {
          query: "invoices queue",
        })) as Hits;
        expect(all.hits.map((hit) => hit.threadId).toSorted()).toEqual(
          [thread.id, worker.thread.id].toSorted(),
        );
        expect(all.hits.find((hit) => hit.threadId === thread.id)).toMatchObject({
          part: "orchestrator",
          role: "user",
          yours: true,
        });
        const fromWorker = all.hits.find((hit) => hit.threadId === worker.thread.id)!;
        expect(fromWorker).toMatchObject({ part: "worker", role: "assistant" });
        expect(typeof fromWorker.seq).toBe("number");

        const withText = (yield* worker.session.callTool("search_transcripts", {
          query: "flaked",
          withText: true,
        })) as Hits;
        expect(withText.hits).toHaveLength(1);
        expect(withText.hits[0]!.text).toContain("flaked under load");
        expect(withText.hits[0]!.text).not.toContain("abcdefghijklmnop");
        expect(withText.hits[0]!.snippet).not.toContain("abcdefghijklmnop");

        const workersOnly = (yield* worker.session.callTool("search_transcripts", {
          query: "invoices",
          workersOnly: true,
        })) as Hits;
        expect(workersOnly.hits.map((hit) => hit.threadId)).toEqual([worker.thread.id]);

        const limited = (yield* session.callTool("search_transcripts", {
          query: "invoices",
          limit: 1,
        })) as Hits;
        expect(limited.hits).toHaveLength(1);
        expect(limited.truncated).toBe(true);

        const outside = yield* Effect.flip(
          Effect.flatMap(AppToolRegistry, (registry) => {
            const tool = registry
              .forThread(plain.id, "orchestrator")
              .find((t) => t.descriptor.name === "search_transcripts")!;
            return tool.run({ query: "invoices" });
          }),
        );
        expect(String(outside.message)).toContain("not part of a workspace");
      }),
    ),
  );
});
