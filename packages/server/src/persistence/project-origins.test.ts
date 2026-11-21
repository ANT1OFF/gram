import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";
import { hasGit, makeRepo, removeDir, run, tempDir } from "../git/test-repo.ts";
import { cloneIdentityOf } from "../host/repos.ts";
import { SqlClient } from "../platform/unstable.ts";
import { ThreadStore } from "./thread-store.ts";

const APP = "https://github.com/acme/app.git";
const OTHER = "https://github.com/someone/private.git";

describe.skipIf(!hasGit)("a project's recorded origin", () => {
  it.effect("is the origin it had when added, whatever its git config names later", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const repo = makeRepo(tmp);
      run(repo, "remote", "add", "origin", APP);
      const layer = ThreadStore.layerSqlite(join(tmp, "gram.db")).pipe(Layer.orDie);
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const added = yield* store.registerProject({ root: repo, name: "app", repoRoot: repo });
        expect(added.project.originIdentity).toBe(cloneIdentityOf(APP));
        run(repo, "remote", "set-url", "origin", OTHER);
        // Added again, listed, and loaded afresh: still the origin it was added with.
        const again = yield* store.registerProject({ root: repo, name: "app", repoRoot: repo });
        expect(again.project.originIdentity).toBe(cloneIdentityOf(APP));
        expect((yield* store.listProjects)[0]?.originIdentity).toBe(cloneIdentityOf(APP));
      }).pipe(Effect.provide(layer));
      const reloaded = yield* ThreadStore.pipe(
        Effect.flatMap((store) => store.listProjects),
        Effect.provide(layer),
      );
      expect(reloaded[0]?.originIdentity).toBe(cloneIdentityOf(APP));
    }),
  );

  it.effect("is read once as the store loads for a project added before origins were kept", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const repo = makeRepo(tmp);
      run(repo, "remote", "add", "origin", APP);
      const layer = ThreadStore.layerSqlite(join(tmp, "gram.db")).pipe(Layer.orDie);
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.registerProject({ root: repo, name: "app", repoRoot: repo });
        // As a project added by a build that kept none.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projects SET origin_identity = NULL`;
      }).pipe(Effect.provide(layer));
      const loaded = yield* ThreadStore.pipe(
        Effect.flatMap((store) => store.listProjects),
        Effect.provide(layer),
      );
      expect(loaded[0]?.originIdentity).toBe(cloneIdentityOf(APP));
    }),
  );

  it.effect("is absent for a folder outside a repository", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const store = yield* ThreadStore;
      const { project } = yield* store.registerProject({ root: tmp, name: "plain" });
      expect(project.originIdentity).toBeUndefined();
    }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
  );
});
