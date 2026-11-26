import { describe, expect, it } from "@effect/vitest";
import type { DocPr, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DocAuthor, type DocLimits, makeDocs } from "./docs.ts";

const WS = "ws-pr" as WorkspaceId;
const worker = (n: number): DocAuthor => ({
  threadId: `t-worker-${n}` as ThreadId,
  title: `Worker ${n}`,
  orchestrator: false,
});
const PR: DocPr = { repo: "acme/widgets", number: 42 };

const setup = (limits?: DocLimits) =>
  Effect.gen(function* () {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-docs-pr-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const docs = makeDocs(join(dir, "docs"), () => Effect.void, undefined, limits);
    const publish = (title: string, author: DocAuthor, pr?: DocPr) =>
      docs.publish({ workspaceId: WS, author, title, content: `${title} text`, pr });
    return { docs, publish };
  });

describe("a PR's doc", () => {
  it.effect(
    "is the one active doc for its PR: a second publish returns it and writes nothing",
    () =>
      Effect.gen(function* () {
        const { docs, publish } = yield* setup({ activeMax: 2 });
        const first = yield* publish("Review of #42", worker(1), PR);
        expect(first).toMatchObject({ action: "published", meta: { pr: PR } });
        const again = yield* publish("Re-review of #42", worker(2), {
          repo: "ACME/Widgets",
          number: 42,
        });
        expect(again).toMatchObject({
          action: "existing",
          meta: { id: first.meta.id, revision: 1 },
        });
        expect((yield* docs.read(WS, first.meta.id)).content).toBe("Review of #42 text");
        expect(yield* docs.counts(WS)).toEqual({ active: 1, archived: 0 });

        // Another PR, or none, is a new doc; filling the active set still finds the PR's.
        const other = yield* publish("Review of #43", worker(2), { ...PR, number: 43 });
        expect((yield* publish("Round 3", worker(3), PR)).action).toBe("existing");

        // Once archived, the PR's next doc starts afresh.
        yield* docs.archive(WS, first.meta.id, worker(1), "manual");
        const next = yield* publish("Review after merge", worker(3), PR);
        expect(next.action).toBe("published");
        // Restoring the first would make two for the PR: refused, with room to spare, until the
        // second is archived.
        yield* docs.archive(WS, other.meta.id, worker(2), "manual");
        expect((yield* Effect.flip(docs.restore(WS, first.meta.id, "user")))._tag).toBe(
          "InvalidState",
        );
        yield* docs.archive(WS, next.meta.id, worker(3), "manual");
        yield* docs.restore(WS, first.meta.id, "user");
        expect((yield* publish("Round 4", worker(2), PR)).meta.id).toBe(first.meta.id);
      }).pipe(Effect.scoped),
  );

  it.effect("may be updated by any thread in the workspace, unlike a doc with no PR", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup();
      const { meta } = yield* publish("Review of #42", worker(1), PR);
      const updated = yield* docs.publish({
        workspaceId: WS,
        author: worker(2),
        id: meta.id,
        revision: 1,
        content: "## Round 2\n\nNew.\n\n## Round 1\n\nOld.",
      });
      expect(updated.meta).toMatchObject({ revision: 2, authorThreadId: "t-worker-1", pr: PR });
      // The round it replaced is kept.
      expect((yield* docs.read(WS, meta.id, 1)).content).toBe("Review of #42 text");
      // Archiving it stays its author's or the orchestrator's.
      expect((yield* Effect.flip(docs.archive(WS, meta.id, worker(2), "manual")))._tag).toBe(
        "InvalidState",
      );

      const plain = yield* publish("Plan", worker(1));
      const refused = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(2),
          id: plain.meta.id,
          revision: 1,
          content: "x",
        }),
      );
      expect(refused._tag).toBe("InvalidState");
    }).pipe(Effect.scoped),
  );
});
