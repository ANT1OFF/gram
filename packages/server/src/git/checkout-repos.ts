import { CheckoutRepos, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { projectRepo, repoOfIdentity } from "./repo-reach.ts";

/** Answers the git platform's `CheckoutRepos` from `store`, where the platform has one. */
export const answerCheckoutRepos = (store: ThreadStoreShape) =>
  Effect.gen(function* () {
    const slot = yield* Effect.serviceOption(CheckoutRepos);
    if (slot._tag === "None") return;
    slot.value.answerWith((workTree) =>
      Effect.gen(function* () {
        const projects = yield* store.listProjects;
        for (const thread of yield* store.listThreads) {
          for (const checkout of [thread.checkout, ...(thread.extraCheckouts ?? [])]) {
            if (!samePath(checkout.path, workTree)) continue;
            if (checkout.cloneIdentity !== undefined) return repoOfIdentity(checkout.cloneIdentity);
            const project = projects.find((each) => each.id === thread.projectId);
            if (project !== undefined) return projectRepo(project);
          }
        }
        const project = projects.find(
          (each) =>
            samePath(each.root, workTree) ||
            (each.repoRoot !== undefined && samePath(each.repoRoot, workTree)),
        );
        return project === undefined ? null : projectRepo(project);
      }).pipe(Effect.orElseSucceed(() => null)),
    );
  });
