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

/** A PR with GitHub's auto-merge armed, the method it merges with, and its head when read. */
export interface ArmedAutoMerge {
  readonly number: number;
  readonly method: "squash" | "merge" | "rebase";
  /** The head commit the auto-merge stood on; `undefined` when GitHub didn't say. */
  readonly head: string | undefined;
}

/** An open PR's head commit, or that it is no longer open. */
export type PrHeadNow = { readonly open: true; readonly head: string } | { readonly open: false };

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
  /** A PR's head now; `undefined` when gh couldn't say. */
  readonly headOf: (
    cwd: string,
    repo: string,
    number: number,
  ) => Effect.Effect<PrHeadNow | undefined>;
  /**
   * Arms a PR's auto-merge again with `method`, pinned to `head` (`--match-head-commit`), so
   * GitHub refuses it once the head has moved; why it couldn't, or `undefined` when it did.
   */
  readonly enable: (
    cwd: string,
    repo: string,
    number: number,
    method: ArmedAutoMerge["method"],
    head: string,
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
        headRefOid: Schema.optionalKey(Schema.NullOr(Schema.String)),
        autoMergeRequest: Schema.NullOr(
          Schema.Struct({ mergeMethod: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
        ),
      }),
    ),
  ),
);

const decodeView = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.String,
      headRefOid: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
);

/** A full commit id (SHA-1 or SHA-256), as `--match-head-commit` takes it. */
const isOid = (text: string | null | undefined): text is string =>
  text != null && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text);

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
          "number,headRefOid,autoMergeRequest",
        ]).pipe(
          Effect.map((out) => {
            if (out.status !== 0) return undefined;
            const listed = Option.getOrUndefined(decodeList(out.stdout));
            return listed
              ?.filter((pr) => pr.autoMergeRequest !== null)
              .map((pr) => ({
                number: pr.number,
                method: methodOf(pr.autoMergeRequest?.mergeMethod),
                head: isOid(pr.headRefOid) ? pr.headRefOid : undefined,
              }));
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      disable: (cwd, repo, number) =>
        act(cwd, ["pr", "merge", String(number), "--disable-auto", "--repo", repo]),
      headOf: (cwd, repo, number) =>
        run(cwd, ["pr", "view", String(number), "--repo", repo, "--json", "state,headRefOid"]).pipe(
          Effect.map((out): PrHeadNow | undefined => {
            if (out.status !== 0) return undefined;
            const view = Option.getOrUndefined(decodeView(out.stdout));
            if (view === undefined) return undefined;
            if (view.state !== "OPEN") return { open: false };
            return isOid(view.headRefOid) ? { open: true, head: view.headRefOid } : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      enable: (cwd, repo, number, method, head) =>
        isOid(head)
          ? act(cwd, [
              "pr",
              "merge",
              String(number),
              "--auto",
              `--${method}`,
              "--match-head-commit",
              head,
              "--repo",
              repo,
            ])
          : Effect.succeed("no head commit to pin the auto-merge to"),
    });
  }),
);
