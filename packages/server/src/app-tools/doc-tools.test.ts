import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  ThreadNotFound,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDocs } from "../docs/docs.ts";
import { publishDocTool, readDocTool } from "./doc-tools.ts";
import { bindAppTools } from "./registry.ts";

const WS = "ws-1" as WorkspaceId;
const ORCHESTRATOR = "t-orch" as ThreadId;
const WORKER = "t-worker" as ThreadId;
const SOLO = "t-solo" as ThreadId;
const GONE_ORCHESTRATOR_WORKER = "t-orphan" as ThreadId;

const THREADS: Record<string, Partial<Thread>> = {
  [ORCHESTRATOR]: {
    id: ORCHESTRATOR,
    title: "Orchestrator · Gram",
    role: "orchestrator",
    workspaceId: WS,
  },
  [WORKER]: {
    id: WORKER,
    title: "cp-artifacts",
    workspaceId: WS,
    spawnedBy: { threadId: ORCHESTRATOR, feature: "cp-artifacts" },
  },
  [GONE_ORCHESTRATOR_WORKER]: {
    id: GONE_ORCHESTRATOR_WORKER,
    title: "orphan",
    workspaceId: WS,
    spawnedBy: { threadId: "t-gone" as ThreadId, feature: "x" },
  },
  [SOLO]: { id: SOLO, title: "Solo" },
};

const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-doc-tools-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const docs = makeDocs(join(dir, "docs"), () => Effect.void);
  const chunks: Array<{ threadId: ThreadId; chunk: GramUIMessageChunk }> = [];
  const store = {
    getThread: (threadId: ThreadId) =>
      THREADS[threadId] === undefined
        ? Effect.fail(new ThreadNotFound({ threadId }))
        : Effect.succeed(THREADS[threadId] as Thread),
  };
  const runtimes = {
    emitChunk: (threadId: ThreadId, chunk: GramUIMessageChunk) =>
      THREADS[threadId] === undefined
        ? Effect.fail(new ThreadNotFound({ threadId }))
        : Effect.sync(() => {
            chunks.push({ threadId, chunk });
            return "m-1" as never;
          }),
  };
  const tools = (threadId: ThreadId) => {
    const bound = bindAppTools(
      [publishDocTool(docs, store, runtimes), readDocTool(docs, store)],
      threadId,
    );
    const named = (name: string) => bound.find((tool) => tool.descriptor.name === name)!;
    return { publish: named("publish_doc"), read: named("read_doc") };
  };
  return { chunks, tools };
});

describe("publish_doc", () => {
  it.effect("leaves a card in the worker's transcript and its orchestrator's chat", () =>
    Effect.gen(function* () {
      const { chunks, tools } = yield* setup;
      const { publish } = tools(WORKER);
      expect(publish.descriptor.class).toBe("self");
      const result = (yield* publish.run({
        title: "Harness features for gram: gap analysis",
        content: "# Gap analysis\n\nWhat Gram lacks.",
      })) as { id: string; revision: number; shown: string };
      expect(result).toMatchObject({
        title: "Harness features for gram: gap analysis",
        revision: 1,
        published: true,
        shown: "as a card in your transcript and your orchestrator's chat",
      });
      const card = {
        type: "data-doc",
        id: `doc:${result.id}:1`,
        data: {
          id: result.id,
          workspaceId: WS,
          title: "Harness features for gram: gap analysis",
          authorThreadId: WORKER,
          authorTitle: "cp-artifacts",
          action: "published",
          revision: 1,
          at: expect.any(Number),
          excerpt: "What Gram lacks.",
        },
      };
      expect(chunks).toEqual([
        { threadId: WORKER, chunk: card },
        { threadId: ORCHESTRATOR, chunk: card },
      ]);

      const updated = yield* publish.run({ id: result.id, revision: 1, content: "Revised." });
      expect(updated).toMatchObject({ revision: 2, updated: true });
      expect(chunks.at(-1)).toMatchObject({
        threadId: ORCHESTRATOR,
        chunk: { id: `doc:${result.id}:2`, data: { action: "updated", excerpt: "Revised." } },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("shows only the orchestrator's own card when it publishes", () =>
    Effect.gen(function* () {
      const { chunks, tools } = yield* setup;
      yield* tools(ORCHESTRATOR).publish.run({ title: "Plan", content: "Steps." });
      expect(chunks.map((c) => c.threadId)).toEqual([ORCHESTRATOR]);
    }).pipe(Effect.scoped),
  );

  it.effect("still publishes when the worker's orchestrator is gone", () =>
    Effect.gen(function* () {
      const { chunks, tools } = yield* setup;
      const result = yield* tools(GONE_ORCHESTRATOR_WORKER).publish.run({
        title: "Notes",
        content: "x",
      });
      expect(result).toMatchObject({ shown: "as a card in your transcript" });
      expect(chunks.map((c) => c.threadId)).toEqual([GONE_ORCHESTRATOR_WORKER]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a thread outside any workspace, and arguments it doesn't take", () =>
    Effect.gen(function* () {
      const { chunks, tools } = yield* setup;
      const error = yield* Effect.flip(tools(SOLO).publish.run({ title: "Plan", content: "x" }));
      expect(error).toBeInstanceOf(AppToolError);
      expect(error.message).toContain("Docs belong to a workspace");
      const excess = yield* Effect.flip(
        tools(WORKER).publish.run({ title: "Plan", content: "x", path: "/etc/passwd" }),
      );
      expect(excess).toBeInstanceOf(AppToolError);
      const badId = yield* Effect.flip(
        tools(WORKER).publish.run({ id: "../../escape", revision: 1, content: "x" }),
      );
      expect(badId).toBeInstanceOf(AppToolError);
      expect(chunks).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets the orchestrator update a worker's doc, but not another worker", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup;
      const { id } = (yield* tools(WORKER).publish.run({ title: "Plan", content: "v1" })) as {
        id: string;
      };
      const other = yield* Effect.flip(
        tools(GONE_ORCHESTRATOR_WORKER).publish.run({ id, revision: 1, content: "x" }),
      );
      expect(other.message).toContain("only that thread or the workspace's orchestrator");
      expect(
        yield* tools(ORCHESTRATOR).publish.run({ id, revision: 1, content: "v2" }),
      ).toMatchObject({ revision: 2 });
    }).pipe(Effect.scoped),
  );
});

describe("read_doc", () => {
  it.effect("lists the workspace's docs and reads one with its revision", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup;
      const { id } = (yield* tools(WORKER).publish.run({
        title: "Plan",
        content: "# Plan\n\nA.",
      })) as {
        id: string;
      };
      const listed = (yield* tools(ORCHESTRATOR).read.run({})) as { docs: unknown[] };
      expect(listed.docs).toEqual([
        {
          id,
          title: "Plan",
          author: "cp-artifacts",
          yours: false,
          revision: 1,
          updatedAt: expect.any(String),
          updatedBy: "agent",
        },
      ]);
      expect(yield* tools(WORKER).read.run({ id })).toMatchObject({
        id,
        revision: 1,
        content: "# Plan\n\nA.",
      });
      const solo = yield* Effect.flip(tools(SOLO).read.run({ id }));
      expect(solo.message).toContain("Docs belong to a workspace");
    }).pipe(Effect.scoped),
  );
});
