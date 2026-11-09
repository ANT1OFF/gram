import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type ProcShape, type Worktrees } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { tempDir, removeDir } from "../git/test-repo.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { cloneFolderOf, reposOn } from "./repos.ts";

const URL = "https://git.example.test/acme/widgets.git";
const OID = "a".repeat(40);
const output = (stdout = OID, status = 0, stderr = "") => ({
  status,
  stdout,
  stderr,
  truncated: false,
});
const worktrees = (onCreate: (base: string | undefined) => void = () => {}) =>
  ({
    create: (request: { repoPath: string; branch: string; base?: string }) =>
      Effect.sync(() => {
        onCreate(request.base);
        return {
          repoTop: request.repoPath,
          reused: false,
          copiedIncludes: 0,
          checkout: {
            kind: "worktree",
            path: join(request.repoPath, ".worktrees", request.branch),
            branch: request.branch,
            base: request.base,
          },
        };
      }),
  }) as unknown as Worktrees["Service"];

describe("joined clone base creation", () => {
  it.effect("serializes base fetches behind the clone's ordinary refresh", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const folder = cloneFolderOf(URL);
      if ("error" in folder) throw new Error(folder.error);
      const path = join(dir, folder.folder);
      mkdirSync(path, { recursive: true });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const created = yield* Deferred.make<void>();
      let explicit = false;
      const proc: ProcShape = {
        run: (_bin, args) => {
          if (args.includes("get-url")) return Effect.succeed(output(URL));
          if (args.includes("--prune"))
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(output()),
            );
          if (args.includes("fetch")) explicit = true;
          return Effect.succeed(output());
        },
      };
      const fetch = yield* Effect.forkScoped(reposOn(proc, dir).ensure(URL));
      yield* Deferred.await(entered);
      const create = yield* Effect.forkScoped(
        cloneWorktrees(proc, worktrees())
          .create({ repoPath: path, branch: "feat/new", base: "origin/main", openCheckouts: [] })
          .pipe(Effect.ensuring(Deferred.succeed(created, undefined))),
      );
      yield* Effect.yieldNow;
      expect(explicit).toBe(false);
      expect(yield* Deferred.isDone(created)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fetch);
      yield* Fiber.join(create);
      expect(explicit).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("pins the base commit used for creation while returning its selected ref", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      let passed: string | undefined;
      const proc: ProcShape = {
        run: (_bin, args) =>
          Effect.succeed(
            args.some((arg) => arg.startsWith("refs/heads/feat/new")) ? output("", 1) : output(),
          ),
      };
      const made = yield* cloneWorktrees(
        proc,
        worktrees((base) => {
          passed = base;
        }),
      ).create({ repoPath: dir, branch: "feat/new", base: "origin/main", openCheckouts: [] });
      expect(passed).toBe(OID);
      expect(made.checkout.base).toBe("origin/main");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a fetch failure accurately and redacts any credentials it contains", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const proc: ProcShape = {
        run: (_bin, args) =>
          Effect.succeed(
            args.includes("fetch")
              ? output(
                  "",
                  128,
                  "fatal: authentication failed for https://user:invented-password@git.example.test/acme/widgets",
                )
              : output(),
          ),
      };
      const error = yield* cloneWorktrees(proc, worktrees())
        .create({ repoPath: dir, branch: "feat/new", base: "origin/main", openCheckouts: [] })
        .pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(error.message).toContain("Couldn't fetch base");
      expect(error.message).not.toContain("invented-password");
      expect(error.message).not.toContain("Push the branch");
    }).pipe(Effect.scoped),
  );
});
