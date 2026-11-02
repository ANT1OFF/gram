import {
  collaboratorPermission,
  fetchPersonComments,
  Proc,
  ReviewActionError,
  Tools,
  type FetchedComment,
  type RepoPermission,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** People's comments on a PR and their authors' permissions, behind a service so tests never reach `gh`. */
export class PrCommentReads extends Context.Service<
  PrCommentReads,
  {
    /** What the comments named by id say now; a deleted one is missing. */
    readonly fetch: (
      workTree: string,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FetchedComment>, ReviewActionError>;
    /** `login`'s permission on `repo`, kept briefly. */
    readonly permission: (
      workTree: string,
      repo: string,
      login: string,
    ) => Effect.Effect<RepoPermission, ReviewActionError>;
  }
>()("@gram/server/PrCommentReads") {
  static readonly layer = Layer.effect(
    PrCommentReads,
    Effect.gen(function* () {
      const proc = yield* Proc;
      const tools = yield* Tools;
      const provide = Effect.provideService(Proc, proc);
      const ready = Effect.gen(function* () {
        if (!(yield* tools.ghReady))
          return yield* new ReviewActionError({ message: "gh is not signed in" });
      });
      return {
        fetch: (workTree, ids) =>
          ready.pipe(Effect.andThen(provide(fetchPersonComments(workTree, ids)))),
        permission: (workTree, repo, login) =>
          ready.pipe(Effect.andThen(provide(collaboratorPermission(workTree, repo, login)))),
      };
    }),
  );

  /** For tests: nothing to read, and nobody may write. */
  static readonly layerOffline = Layer.succeed(PrCommentReads, {
    fetch: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
    permission: () => Effect.succeed("none" as const),
  });
}
