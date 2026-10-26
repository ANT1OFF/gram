import type { MergeStrategy } from "@gram/contracts";
import {
  closePr,
  mergePr,
  Proc,
  PrActionError,
  reopenPr,
  repoMergeSettings,
  setPrDraft,
  updatePrBranch,
  type RepoMergeSettings,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Pull request writes for the PR panel, behind a service so tests never reach `gh`. */
export class PrActions extends Context.Service<
  PrActions,
  {
    readonly merge: (
      workTree: string,
      repo: string,
      number: number,
      strategy: MergeStrategy,
      auto: boolean,
    ) => Effect.Effect<void, PrActionError>;
    readonly setDraft: (
      workTree: string,
      repo: string,
      number: number,
      draft: boolean,
    ) => Effect.Effect<void, PrActionError>;
    readonly close: (
      workTree: string,
      repo: string,
      number: number,
    ) => Effect.Effect<void, PrActionError>;
    readonly reopen: (
      workTree: string,
      repo: string,
      number: number,
    ) => Effect.Effect<void, PrActionError>;
    readonly updateBranch: (
      workTree: string,
      repo: string,
      number: number,
    ) => Effect.Effect<void, PrActionError>;
    readonly mergeSettings: (
      workTree: string,
      repo: string,
    ) => Effect.Effect<RepoMergeSettings, PrActionError>;
  }
>()("@gram/server/PrActions") {
  static readonly layer = Layer.effect(
    PrActions,
    Effect.gen(function* () {
      const proc = yield* Proc;
      const provide = Effect.provideService(Proc, proc);
      return {
        merge: (workTree, repo, number, strategy, auto) =>
          provide(mergePr(workTree, repo, number, strategy, auto)),
        setDraft: (workTree, repo, number, draft) =>
          provide(setPrDraft(workTree, repo, number, draft)),
        close: (workTree, repo, number) => provide(closePr(workTree, repo, number)),
        reopen: (workTree, repo, number) => provide(reopenPr(workTree, repo, number)),
        updateBranch: (workTree, repo, number) => provide(updatePrBranch(workTree, repo, number)),
        mergeSettings: (workTree, repo) => provide(repoMergeSettings(workTree, repo)),
      };
    }),
  );

  /** For tests: every write and settings read is refused. */
  static readonly layerOffline = Layer.succeed(PrActions, {
    merge: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
    setDraft: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
    close: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
    reopen: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
    updateBranch: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
    mergeSettings: () => Effect.fail(new PrActionError({ message: "no network in tests" })),
  });
}
