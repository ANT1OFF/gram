import { describe, expect, it } from "@effect/vitest";
import type { DocId, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DocAuthor, type DocLimits, makeDocs } from "./docs.ts";

const WS = "ws-archive" as WorkspaceId;
const worker = (n: number): DocAuthor => ({
  threadId: `t-worker-${n}` as ThreadId,
  title: `Worker ${n}`,
  orchestrator: false,
});
const ORCHESTRATOR: DocAuthor = {
  threadId: "t-orchestrator" as ThreadId,
  title: "Orchestrator",
  orchestrator: true,
};

const setup = (limits?: DocLimits) =>
  Effect.gen(function* () {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-docs-archive-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const root = join(dir, "docs");
    let changed = 0;
    const docs = makeDocs(root, () => Effect.sync(() => void changed++), undefined, limits);
    const publish = (title: string, author = worker(1), content = `${title} text`) =>
      docs
        .publish({ workspaceId: WS, author, title, content })
        .pipe(Effect.map(({ meta }) => meta.id));
    return { root, docs, publish, changes: () => changed };
  });

describe("archived docs", () => {
  it.effect("count apart from the active cap, which archiving makes room under", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup({ activeMax: 2 });
      const first = yield* publish("First");
      yield* publish("Second");
      const full = yield* Effect.flip(publish("Third"));
      expect(full._tag).toBe("InvalidState");

      yield* docs.archive(WS, first, worker(1), "manual");
      const third = yield* publish("Third");
      expect((yield* docs.list(WS)).map((doc) => doc.id)).not.toContain(first);
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toContain(third);
      expect(yield* docs.counts(WS)).toEqual({ active: 2, archived: 1 });
      // Still readable by id, and listed in the archive with when and why.
      const archived = yield* docs.read(WS, first);
      expect(archived).toMatchObject({
        id: first,
        content: "First text",
        archivedReason: "manual",
      });
      expect((yield* docs.listArchived(WS)).map((doc) => doc.id)).toEqual([first]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuse to restore into a full active set, and stay archived", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup({ activeMax: 1 });
      const old = yield* publish("Old");
      yield* docs.archive(WS, old, worker(1), "manual");
      const current = yield* publish("Current");
      const refused = yield* Effect.flip(docs.restore(WS, old, worker(1)));
      expect(refused._tag).toBe("InvalidState");
      // The refusal names the way out.
      expect(refused.message).toContain("archive_doc");
      expect(yield* docs.counts(WS)).toEqual({ active: 1, archived: 1 });

      yield* docs.archive(WS, current, worker(1), "manual");
      const restored = yield* docs.restore(WS, old, worker(1));
      expect(restored.archivedAt).toBeUndefined();
      expect(restored.archivedReason).toBeUndefined();
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([old]);
      expect((yield* docs.read(WS, old)).archivedAt).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("are archived and restored only by their author, the orchestrator or the user", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup();
      const id = yield* publish("Mine");
      const other = yield* Effect.flip(docs.archive(WS, id, worker(2), "manual"));
      expect(other._tag).toBe("InvalidState");
      expect(yield* docs.counts(WS)).toEqual({ active: 1, archived: 0 });

      yield* docs.archive(WS, id, worker(1), "manual");
      expect((yield* Effect.flip(docs.restore(WS, id, worker(2))))._tag).toBe("InvalidState");
      yield* docs.restore(WS, id, ORCHESTRATOR);
      yield* docs.archive(WS, id, "user", "manual");
      yield* docs.restore(WS, id, "user");
      expect(yield* docs.counts(WS)).toEqual({ active: 1, archived: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("are deleted only once archived, and only by the orchestrator or the user", () =>
    Effect.gen(function* () {
      const { root, docs, publish } = yield* setup();
      const id = yield* publish("Mine");
      yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id,
        revision: 1,
        content: "v2",
      });
      // Active: no one deletes it, the orchestrator included.
      expect((yield* Effect.flip(docs.remove(WS, id, ORCHESTRATOR)))._tag).toBe("InvalidState");
      yield* docs.archive(WS, id, worker(1), "manual");
      // Its author may archive it, but not delete it.
      expect((yield* Effect.flip(docs.remove(WS, id, worker(1))))._tag).toBe("InvalidState");
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 1 });

      yield* docs.remove(WS, id, ORCHESTRATOR);
      expect((yield* Effect.flip(docs.read(WS, id)))._tag).toBe("NotFound");
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 0 });
      // Its earlier versions go with it.
      expect(existsSync(join(root, WS, "history", id))).toBe(false);

      const second = yield* publish("Second");
      yield* docs.archive(WS, second, "user", "manual");
      yield* docs.remove(WS, second, "user");
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("past the archive's cap, purge the earliest archived first", () =>
    Effect.gen(function* () {
      const { root, docs, publish } = yield* setup({ archiveMax: 2 });
      yield* TestClock.setTime(1_000);
      const a = yield* publish("A");
      const b = yield* publish("B");
      const c = yield* publish("C");
      // `a` is saved last but archived first: archiving order, not saving order, decides.
      yield* TestClock.setTime(2_000);
      yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id: a,
        revision: 1,
        content: "a2",
      });
      yield* TestClock.setTime(3_000);
      yield* docs.archive(WS, a, worker(1), "manual");
      yield* TestClock.setTime(4_000);
      yield* docs.archive(WS, b, worker(1), "manual");
      yield* TestClock.setTime(5_000);
      yield* docs.archive(WS, c, worker(1), "manual");

      expect((yield* docs.listArchived(WS)).map((doc) => doc.id)).toEqual([c, b]);
      expect((yield* Effect.flip(docs.read(WS, a)))._tag).toBe("NotFound");
      expect(existsSync(join(root, WS, "history", a))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuse an agent's update or the user's save until restored", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup();
      const id = yield* publish("Plan");
      yield* docs.archive(WS, id, worker(1), "manual");
      const update = yield* Effect.flip(
        docs.publish({ workspaceId: WS, author: worker(1), id, revision: 1, content: "x" }),
      );
      expect(update._tag).toBe("InvalidState");
      expect((yield* Effect.flip(docs.save(WS, id, "x", 1)))._tag).toBe("InvalidState");
      expect((yield* docs.read(WS, id)).content).toBe("Plan text");
    }).pipe(Effect.scoped),
  );

  it.effect("leave a move cut short active, not listed twice", () =>
    Effect.gen(function* () {
      const { root, docs, publish } = yield* setup();
      const id = yield* publish("Plan");
      yield* docs.archive(WS, id, worker(1), "manual");
      yield* docs.restore(WS, id, worker(1));
      // The archived copy was written but the active one never went.
      const record = readFileSync(join(root, WS, `${id}.doc`), "utf8");
      writeFileSync(join(root, WS, "archive", `${id}.doc`), record);
      expect(yield* docs.listArchived(WS)).toEqual([]);
      expect(yield* docs.counts(WS)).toEqual({ active: 1, archived: 0 });
      yield* docs.archive(WS, id, worker(1), "manual");
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 1 });
    }).pipe(Effect.scoped),
  );
});

describe("doc history", () => {
  it.effect("keeps the versions an update replaces, the newest few, through an archive", () =>
    Effect.gen(function* () {
      const { root, docs, publish } = yield* setup({ historyKeep: 2 });
      const id = yield* publish("Plan", worker(1), "v1");
      const update = (revision: number, content: string) =>
        docs.publish({ workspaceId: WS, author: worker(1), id, revision, content });
      yield* update(1, "v2");
      expect(yield* docs.history(WS, id)).toEqual([1]);
      expect(yield* docs.read(WS, id, 1)).toMatchObject({ revision: 1, content: "v1" });
      expect((yield* docs.read(WS, id)).content).toBe("v2");

      // The user's save keeps the version it replaces too.
      yield* docs.save(WS, id, "the user's v3", 2);
      yield* update(3, "v4");
      expect(yield* docs.history(WS, id)).toEqual([3, 2]);
      expect((yield* docs.read(WS, id, 3)).content).toBe("the user's v3");
      expect((yield* Effect.flip(docs.read(WS, id, 1)))._tag).toBe("NotFound");
      expect(readdirSync(join(root, WS, "history", id)).toSorted()).toEqual(["2.doc", "3.doc"]);

      yield* docs.archive(WS, id, worker(1), "manual");
      expect((yield* docs.read(WS, id, 2)).content).toBe("v2");
      yield* docs.restore(WS, id, worker(1));
      expect(yield* docs.history(WS, id)).toEqual([3, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads no version from outside the doc's own history", () =>
    Effect.gen(function* () {
      const { root, docs, publish } = yield* setup();
      const id = yield* publish("Plan", worker(1), "v1");
      const other = yield* publish("Other", worker(1), "secret");
      yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id: other,
        revision: 1,
        content: "x",
      });
      // Another doc's kept version, copied under this doc's name, doesn't read as this doc's.
      const foreign = readFileSync(join(root, WS, "history", other, "1.doc"), "utf8");
      yield* docs.publish({ workspaceId: WS, author: worker(1), id, revision: 1, content: "v2" });
      writeFileSync(join(root, WS, "history", id, "7.doc"), foreign);
      const error = yield* Effect.flip(docs.read(WS, id, 7));
      expect(error._tag).toBe("InvalidState");
      expect((yield* Effect.flip(docs.read(WS, id, -1)))._tag).toBe("NotFound");
      expect((yield* Effect.flip(docs.read(WS, "../x" as DocId)))._tag).toBe("InvalidState");
    }).pipe(Effect.scoped),
  );
});
