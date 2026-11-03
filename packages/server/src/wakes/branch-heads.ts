/**
 * Where a repo's branches stand on GitHub, for the condition wakes that wait on them: its default
 * branch and a branch's head commit. One bounded REST `gh api` each, run in a folder of the waiting
 * thread's (gh needs one to start in, and it picks the host from there), and paced to the
 * background share of the allowance like the other polls.
 */
import { ghApi, Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asBackground, GhBudget } from "../github/budget.ts";

export interface BranchHeadsShape {
  /** The repo's default branch; `undefined` when GitHub couldn't be read or has no such repo. */
  readonly defaultBranch: (cwd: string, repo: string) => Effect.Effect<string | undefined>;
  /**
   * The branch's head commit; `null` when GitHub says there is no such branch, `undefined` when it
   * couldn't be read (offline, rate-limited, out of the background allowance).
   */
  readonly head: (
    cwd: string,
    repo: string,
    branch: string,
  ) => Effect.Effect<string | null | undefined>;
}

export class BranchHeads extends Context.Service<BranchHeads, BranchHeadsShape>()(
  "@gram/server/BranchHeads",
) {}

const decodeRepo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ default_branch: Schema.String })),
);
const decodeBranch = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) })),
);

/** GitHub has no such repo or branch. */
const NOT_FOUND = /not found|HTTP 404/i;

export const BranchHeadsLive = Layer.effect(
  BranchHeads,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const budget = yield* GhBudget;
    const api = (cwd: string, path: string) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit("core", "background")).allowed) return undefined;
        return yield* ghApi(cwd, [path]).pipe(
          Effect.provideService(Proc, proc),
          asBackground,
          Effect.orElseSucceed(() => undefined),
        );
      });
    return BranchHeads.of({
      defaultBranch: (cwd, repo) =>
        api(cwd, `repos/${repo}`).pipe(
          Effect.map((out) => {
            if (out === undefined || out.status !== 0) return undefined;
            return Option.getOrUndefined(decodeRepo(out.stdout))?.default_branch;
          }),
        ),
      head: (cwd, repo, branch) =>
        api(cwd, `repos/${repo}/branches/${branch}`).pipe(
          Effect.map((out) => {
            if (out === undefined) return undefined;
            if (out.status !== 0) return NOT_FOUND.test(out.stderr) ? null : undefined;
            return Option.getOrUndefined(decodeBranch(out.stdout))?.commit.sha;
          }),
        ),
    });
  }),
);
