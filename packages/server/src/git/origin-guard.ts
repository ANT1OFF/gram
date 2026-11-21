import type { Project } from "@gram/contracts";
import { git, guardOrigins, isInside, OriginRefused, type Proc, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import { dirname } from "node:path";
import { githubRelayed } from "../embedding/github-relay.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { effectiveOriginsChecked } from "./recorded-clone.ts";

const atRoot = (project: Project, dir: string) =>
  samePath(project.root, dir) ||
  (project.repoRoot !== undefined && samePath(project.repoRoot, dir));

/**
 * The project `dir` is a folder of: a project's own folder or repository, a thread's checkout, a
 * folder inside a project, or a worktree of a project's repository (by its shared git folder).
 * `undefined` for a folder of none, which has no recorded origin to be held to.
 */
export const projectOfFolder = (
  store: Pick<ThreadStoreShape, "listProjects" | "listThreads">,
  dir: string,
): Effect.Effect<Project | undefined, never, Proc> =>
  Effect.gen(function* () {
    const projects = yield* store.listProjects;
    const own = projects.find((project) => atRoot(project, dir));
    if (own !== undefined) return own;
    for (const thread of yield* store.listThreads) {
      for (const checkout of [thread.checkout, ...(thread.extraCheckouts ?? [])]) {
        if (!samePath(checkout.path, dir)) continue;
        const project = projects.find((each) => each.id === thread.projectId);
        if (project !== undefined) return project;
      }
    }
    const inside = projects.find(
      (project) =>
        isInside(project.root, dir) ||
        (project.repoRoot !== undefined && isInside(project.repoRoot, dir)),
    );
    if (inside !== undefined) return inside;
    const common = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeoutMs: 2_000,
    }).pipe(Effect.option);
    if (common._tag === "None" || common.value.status !== 0) return undefined;
    const shared = common.value.stdout.trim();
    return projects.find((project) => atRoot(project, dirname(shared)));
  });

/** The server's origin guard: nothing without a route; behind one, `dir`'s origin as its project's. */
export const storeOriginGuard =
  (store: Pick<ThreadStoreShape, "listProjects" | "listThreads">) => (dir: string) =>
    Effect.gen(function* () {
      if (!githubRelayed()) return;
      const project = yield* projectOfFolder(store, dir);
      yield* effectiveOriginsChecked(project, dir).pipe(
        Effect.mapError((refused) => new OriginRefused({ message: refused.message })),
      );
    });

/**
 * Puts `store`'s guard in place for as long as the scope lasts: behind a GitHub route, each git of
 * the server's that reaches a folder's origin (`remoteGit`) first asks whether it is the
 * repository the folder's project was added with (`effectiveOriginsChecked`).
 */
export const guardStoreOrigins = (store: Pick<ThreadStoreShape, "listProjects" | "listThreads">) =>
  Effect.acquireRelease(
    Effect.sync(() => guardOrigins(storeOriginGuard(store))),
    (release) => Effect.sync(release),
  );
