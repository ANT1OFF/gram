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
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDocs } from "../docs/docs.ts";
import { archiveDocTool, deleteDocTool, publishDocTool, readDocTool } from "./doc-tools.ts";
import { bindAppTools } from "./registry.ts";

const WS = "ws-1" as WorkspaceId;
const ORCHESTRATOR = "t-orch" as ThreadId;
const WORKER = "t-worker" as ThreadId;
const SOLO = "t-solo" as ThreadId;
const GONE_ORCHESTRATOR_WORKER = "t-orphan" as ThreadId;
const BUILDER = "t-builder" as ThreadId;
const REVIEWER = "t-reviewer" as ThreadId;

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
  [BUILDER]: {
    id: BUILDER,
    title: "docs-archive",
    workspaceId: WS,
    spawnedBy: { threadId: ORCHESTRATOR, feature: "docs-archive" },
    boundPr: { repo: "acme/widgets", number: 42, monitor: false },
  },
  [REVIEWER]: {
    id: REVIEWER,
    title: "Review #42",
    workspaceId: WS,
    spawnedBy: { threadId: ORCHESTRATOR, feature: "review" },
  },
};

const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-doc-tools-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const root = join(dir, "docs");
  const docs = makeDocs(root, () => Effect.void);
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
      [
        publishDocTool(docs, store, runtimes),
        readDocTool(docs, store),
        archiveDocTool(docs, store),
        deleteDocTool(docs, store),
      ],
      threadId,
    );
    const named = (name: string) => bound.find((tool) => tool.descriptor.name === name)!;
    return {
      publish: named("publish_doc"),
      read: named("read_doc"),
      archive: named("archive_doc"),
      remove: named("delete_doc"),
    };
  };
  return { chunks, tools, root, docs };
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

  it.effect(
    "names a thread's earlier docs back to it on a new publish, so a later pass updates one",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* setup;
        const { publish } = tools(WORKER);
        const first = (yield* publish.run({ title: "Review of #348", content: "First pass." })) as {
          id: string;
          earlier?: unknown;
          note?: string;
        };
        // Its first doc: nothing to point back to.
        expect(first.earlier).toBeUndefined();
        expect(first.note).toBeUndefined();
        const second = (yield* publish.run({
          title: "Re-review of #348",
          content: "Second pass.",
        })) as { earlier?: unknown; note?: string };
        expect(second.earlier).toEqual([{ id: first.id, title: "Review of #348", revision: 1 }]);
        expect(second.note).toContain("updates that doc by its id");
        // Another thread's docs aren't its own to update, so they aren't named.
        const other = (yield* tools(ORCHESTRATOR).publish.run({
          title: "Plan",
          content: "Steps.",
        })) as { earlier?: unknown };
        expect(other.earlier).toBeUndefined();
        // An update names none: it is the one doc already.
        const updated = (yield* publish.run({
          id: first.id,
          revision: 1,
          content: "Revised.",
        })) as { earlier?: unknown };
        expect(updated.earlier).toBeUndefined();
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

  it.effect("lists past a record with an impossible time instead of throwing (review P5)", () =>
    Effect.gen(function* () {
      const { tools, root } = yield* setup;
      const { id } = (yield* tools(WORKER).publish.run({ title: "Plan", content: "A." })) as {
        id: string;
      };
      const record = readFileSync(join(root, WS, `${id}.doc`), "utf8");
      const [line, ...rest] = record.split("\n");
      const meta = JSON.parse(line!) as Record<string, unknown>;
      writeFileSync(
        join(root, WS, "far-future.doc"),
        `${JSON.stringify({ ...meta, id: "far-future", updatedAt: 1e100 })}\n${rest.join("\n")}`,
      );
      const listed = (yield* tools(ORCHESTRATOR).read.run({})) as { docs: Array<{ id: string }> };
      expect(listed.docs.map((doc) => doc.id)).toEqual([id]);
    }).pipe(Effect.scoped),
  );
});

describe("read_doc listings", () => {
  it.effect("names at most 50 active docs, newest first, and counts the rest", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup;
      const { publish, read, archive } = tools(WORKER);
      const ids: string[] = [];
      for (let n = 0; n < 53; n++) {
        yield* TestClock.adjust("1 second");
        const title = n === 3 ? "Review 3 of the storage PR" : `Review ${n}`;
        const { id } = (yield* publish.run({ title, content: "x" })) as {
          id: string;
        };
        ids.push(id);
      }
      yield* archive.run({ id: ids[0]! });
      const listed = (yield* read.run({})) as {
        docs: Array<{ id: string }>;
        active: number;
        archived: number;
        more?: number;
      };
      expect(listed.docs).toHaveLength(50);
      expect(listed.docs[0]!.id).toBe(ids[52]);
      expect(listed).toMatchObject({ active: 52, archived: 1, more: 2 });
      expect(listed.docs.map((doc) => doc.id)).not.toContain(ids[0]);

      // `query` reaches past the first 50, by the title's words, case ignored.
      const found = (yield* read.run({ query: "STORAGE review" })) as {
        docs: Array<{ id: string }>;
        matched: number;
        more?: number;
      };
      expect(found.docs.map((doc) => doc.id)).toEqual([ids[3]]);
      expect(found).toMatchObject({ matched: 1 });
      expect(found.more).toBeUndefined();
      expect((yield* read.run({ query: "review" })) as object).toMatchObject({
        matched: 52,
        more: 2,
      });
      // A word is matched in the title, never in an id's random tail; a whole id finds its doc.
      for (const word of ["a", "b", "c", "d", "e", "f"]) {
        expect((yield* read.run({ query: `review 3${word}` })) as object).toMatchObject({
          matched: 0,
        });
      }
      expect((yield* read.run({ query: ids[7]! })) as object).toMatchObject({
        docs: [{ id: ids[7] }],
      });

      const archived = (yield* read.run({ archived: true })) as {
        docs: Array<{ id: string; archivedAt?: string; archivedReason?: string }>;
      };
      expect(archived.docs).toEqual([
        expect.objectContaining({
          id: ids[0],
          archivedAt: expect.any(String),
          archivedReason: "manual",
        }),
      ]);
      expect((yield* read.run({ archived: true, query: "review 2" })) as object).toMatchObject({
        docs: [],
        matched: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reads an archived doc by id, and an earlier version by revision", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup;
      const { publish, read, archive } = tools(WORKER);
      const { id } = (yield* publish.run({ title: "Plan", content: "v1" })) as { id: string };
      yield* publish.run({ id, revision: 1, content: "v2" });
      yield* archive.run({ id });
      expect(yield* read.run({ id })).toMatchObject({
        revision: 2,
        content: "v2",
        archivedReason: "manual",
        earlierRevisions: [1],
      });
      expect(yield* read.run({ id, revision: 1 })).toMatchObject({ revision: 1, content: "v1" });
      expect((yield* Effect.flip(read.run({ revision: 1 }))).message).toContain("`id`");
    }).pipe(Effect.scoped),
  );
});

describe("archive_doc and delete_doc", () => {
  it.effect(
    "let a doc's author or the orchestrator archive and restore it, not another worker",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* setup;
        const { id } = (yield* tools(WORKER).publish.run({ title: "Plan", content: "x" })) as {
          id: string;
        };
        const other = yield* Effect.flip(tools(GONE_ORCHESTRATOR_WORKER).archive.run({ id }));
        expect(other).toBeInstanceOf(AppToolError);
        expect(yield* tools(WORKER).archive.run({ id })).toMatchObject({ id, archived: true });
        const restoreByOther = yield* Effect.flip(
          tools(GONE_ORCHESTRATOR_WORKER).archive.run({ id, restore: true }),
        );
        expect(restoreByOther).toBeInstanceOf(AppToolError);
        expect(yield* tools(ORCHESTRATOR).archive.run({ id, restore: true })).toMatchObject({
          id,
          restored: true,
        });
        expect(yield* tools(ORCHESTRATOR).archive.run({ id })).toMatchObject({ archived: true });
        expect(yield* Effect.flip(tools(SOLO).archive.run({ id }))).toBeInstanceOf(AppToolError);
      }).pipe(Effect.scoped),
  );

  it.effect("lets only the orchestrator delete, and only an archived doc", () =>
    Effect.gen(function* () {
      const { tools, docs } = yield* setup;
      expect(deleteDocTool(docs, { getThread: () => Effect.die("unused") }).audience).toEqual([
        "orchestrator",
      ]);
      const { id } = (yield* tools(WORKER).publish.run({ title: "Plan", content: "x" })) as {
        id: string;
      };
      // Bound to a worker anyway, the call is still refused: the check is the service's too.
      yield* tools(WORKER).archive.run({ id });
      expect(yield* Effect.flip(tools(WORKER).remove.run({ id }))).toBeInstanceOf(AppToolError);
      yield* tools(WORKER).archive.run({ id, restore: true });
      const active = yield* Effect.flip(tools(ORCHESTRATOR).remove.run({ id }));
      expect(active).toBeInstanceOf(AppToolError);

      yield* tools(ORCHESTRATOR).archive.run({ id });
      expect(yield* tools(ORCHESTRATOR).remove.run({ id })).toEqual({ id, deleted: true });
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 0 });
    }).pipe(Effect.scoped),
  );
});

describe("publish_doc for a PR", () => {
  it.effect(
    "binds a doc to the author's PR, and hands a reviewer's round that doc to fold into",
    () =>
      Effect.gen(function* () {
        const { chunks, tools } = yield* setup;
        const first = (yield* tools(BUILDER).publish.run({
          title: "Design notes",
          content: "Round 1.",
        })) as { id: string; pr?: string };
        expect(first.pr).toBe("acme/widgets#42");
        const cards = chunks.length;

        const round = (yield* tools(REVIEWER).publish.run({
          title: "Review of #42",
          content: "Round 2.",
          pr: { repo: "acme/widgets", number: 42 },
        })) as { id: string; revision: number; existing?: boolean; published?: boolean };
        expect(round).toMatchObject({
          id: first.id,
          revision: 1,
          existing: true,
          published: false,
        });
        // Nothing was published, so no card either.
        expect(chunks).toHaveLength(cards);

        expect(
          yield* tools(REVIEWER).publish.run({
            id: first.id,
            revision: 1,
            content: "## Round 2\n\nRound 2.\n\n## Round 1\n\nRound 1.",
          }),
        ).toMatchObject({ id: first.id, revision: 2, updated: true });
        expect(yield* tools(ORCHESTRATOR).read.run({})).toMatchObject({
          docs: [{ id: first.id, author: "docs-archive", pr: "acme/widgets#42" }],
        });
      }).pipe(Effect.scoped),
  );

  it.effect("binds none with `pr: null`, and refuses `pr` on an update", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup;
      const plain = (yield* tools(BUILDER).publish.run({
        title: "Unrelated notes",
        content: "x",
        pr: null,
      })) as { id: string; pr?: string };
      expect(plain.pr).toBeUndefined();
      // Not a PR's doc, so another worker may not update it.
      expect(
        yield* Effect.flip(
          tools(REVIEWER).publish.run({ id: plain.id, revision: 1, content: "y" }),
        ),
      ).toBeInstanceOf(AppToolError);
      const moved = yield* Effect.flip(
        tools(BUILDER).publish.run({
          id: plain.id,
          revision: 1,
          content: "y",
          pr: { repo: "acme/widgets", number: 7 },
        }),
      );
      expect(moved).toBeInstanceOf(AppToolError);
    }).pipe(Effect.scoped),
  );
});
