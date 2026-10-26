import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectId, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { checkoutUseHandlers } from "./checkout-use.ts";

const thread = (id: string, projectId: ProjectId, path: string, parked = false): Thread => ({
  id: id as ThreadId,
  projectId,
  title: `Thread ${id}`,
  userNamed: false,
  model: { agent: "claude", model: "opus" },
  mode: "default",
  checkout: { kind: "main", path },
  labels: [],
  pinned: false,
  parked,
  unread: false,
  createdAt: 1,
  lastActivityAt: 1,
});

const tempFolder = () =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-checkout-use-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

describe("threads.usingCheckout", () => {
  it.effect("lists the threads using a folder, parked ones too, however the path is spelled", () =>
    Effect.gen(function* () {
      const dir = yield* tempFolder();
      const elsewhere = yield* tempFolder();
      const store = yield* ThreadStore;
      const project = yield* store.ensureProject({ root: dir, name: "repo" });
      yield* store.insertThread(thread("t-open", project.id, dir));
      yield* store.insertThread(thread("t-parked", project.id, `${dir}/`, true));
      yield* store.insertThread(thread("t-other", project.id, elsewhere));

      const handlers = yield* checkoutUseHandlers;
      const using = (path: string) =>
        handlers["threads.usingCheckout"]({ path }).pipe(
          Effect.map(({ threads }) => threads.map((t) => [t.threadId, t.parked])),
        );
      const expected = [
        ["t-open", false],
        ["t-parked", true],
      ];
      expect(yield* using(dir)).toEqual(expected);
      expect(yield* using(`${dir}/`)).toEqual(expected);
      // Another case is the same folder only where the volume ignores case, as `samePath` reads it.
      const upper = dir.toUpperCase();
      expect(yield* using(upper)).toEqual(existsSync(upper) ? expected : []);
      expect(yield* using(join(dir, "missing"))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
  );
});
