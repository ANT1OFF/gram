/**
 * GitHub's own auto-merge on a repo's open pull requests, which a merge freeze takes down while it
 * stands and puts back after (`merge-freezes.ts`): GitHub merges an armed PR by itself, under any
 * freeze of Gram's. One bounded `gh` each, with `--repo`, run in a folder Gram has for the repo;
 * and which repo a checkout's origin is, which scopes a freeze to the caller's workspace.
 */
import { gh, gitFailMsg, originOwnerRepo, Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A PR with GitHub's auto-merge armed, and the method it merges with. */
export interface ArmedAutoMerge {
  readonly number: number;
  readonly method: "squash" | "merge" | "rebase";
}

export interface AutoMergesShape {
  /** The `owner/repo` of a checkout's origin, as `--repo` names it; `undefined` without one. */
  readonly repoOf: (cwd: string) => Effect.Effect<string | undefined>;
  /** The repo's open PRs onto `base` with auto-merge armed; `undefined` when gh couldn't say. */
  readonly armed: (
    cwd: string,
    repo: string,
    base: string,
  ) => Effect.Effect<ReadonlyArray<ArmedAutoMerge> | undefined>;
  /** Turns a PR's auto-merge off; why it couldn't, or `undefined` when it did. */
  readonly disable: (
    cwd: string,
    repo: string,
    number: number,
  ) => Effect.Effect<string | undefined>;
  /** Arms a PR's auto-merge again with `method`; why it couldn't, or `undefined` when it did. */
  readonly enable: (
    cwd: string,
    repo: string,
    number: number,
    method: ArmedAutoMerge["method"],
  ) => Effect.Effect<string | undefined>;
}

export class AutoMerges extends Context.Service<AutoMerges, AutoMergesShape>()(
  "@gram/server/AutoMerges",
) {}

const decodeList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        autoMergeRequest: Schema.NullOr(
          Schema.Struct({ mergeMethod: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
        ),
      }),
    ),
  ),
);

const methodOf = (raw: string | null | undefined): ArmedAutoMerge["method"] => {
  switch (raw?.toUpperCase()) {
    case "MERGE":
      return "merge";
    case "REBASE":
      return "rebase";
    default:
      return "squash";
  }
};

export const AutoMergesLive = Layer.effect(
  AutoMerges,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      gh(cwd, args).pipe(Effect.provideService(Proc, proc));
    const act = (cwd: string, args: ReadonlyArray<string>) =>
      run(cwd, args).pipe(
        Effect.map((out) => (out.status === 0 ? undefined : gitFailMsg(out, "gh pr merge failed"))),
        Effect.catch((e) => Effect.succeed(e.message)),
      );
    return AutoMerges.of({
      repoOf: (cwd) => originOwnerRepo(cwd).pipe(Effect.provideService(Proc, proc)),
      armed: (cwd, repo, base) =>
        run(cwd, [
          "pr",
          "list",
          "--repo",
          repo,
          "--base",
          base,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,autoMergeRequest",
        ]).pipe(
          Effect.map((out) => {
            if (out.status !== 0) return undefined;
            const listed = Option.getOrUndefined(decodeList(out.stdout));
            return listed
              ?.filter((pr) => pr.autoMergeRequest !== null)
              .map((pr) => ({
                number: pr.number,
                method: methodOf(pr.autoMergeRequest?.mergeMethod),
              }));
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      disable: (cwd, repo, number) =>
        act(cwd, ["pr", "merge", String(number), "--disable-auto", "--repo", repo]),
      enable: (cwd, repo, number, method) =>
        act(cwd, ["pr", "merge", String(number), "--auto", `--${method}`, "--repo", repo]),
    });
  }),
);
