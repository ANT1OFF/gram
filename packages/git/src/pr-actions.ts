// Pull request writes over `gh pr`, and the repository's merge settings, run in the thread's checkout
// so `gh` picks up its host and auth. Every write is the user's explicit action from the PR panel.

import type { MergeStrategy } from "@gram/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { gh, ghApi, gitFailMsg } from "./exec.ts";
import { invalidatePrBadges } from "./pr-cache.ts";
import type { Proc } from "./proc.ts";

/** A pull request write or settings read failed: gh missing, auth, network, or GitHub refused it. */
export class PrActionError extends Data.TaggedError("PrActionError")<{
  readonly message: string;
}> {}

export interface RepoMergeSettings {
  /** The strategies the repository allows, squash first. */
  readonly strategies: ReadonlyArray<MergeStrategy>;
  readonly autoMerge: boolean;
}

const run = (
  workTree: string,
  args: ReadonlyArray<string>,
  fallback: string,
): Effect.Effect<string, PrActionError, Proc> =>
  Effect.gen(function* () {
    const out = yield* gh(workTree, args).pipe(
      Effect.mapError((e) => new PrActionError({ message: e.message })),
    );
    if (out.status !== 0) return yield* new PrActionError({ message: gitFailMsg(out, fallback) });
    return out.stdout;
  });

/** A write: the badges read before it are stale, even when `gh` fails part-way through. */
const write = (
  workTree: string,
  args: ReadonlyArray<string>,
  fallback: string,
): Effect.Effect<void, PrActionError, Proc> =>
  run(workTree, args, fallback).pipe(
    Effect.asVoid,
    Effect.ensuring(Effect.sync(invalidatePrBadges)),
  );

/** Merges now, or with `auto` turns on auto-merge so GitHub merges once the requirements pass. */
export const mergePr = (
  workTree: string,
  repo: string,
  number: number,
  strategy: MergeStrategy,
  auto: boolean,
): Effect.Effect<void, PrActionError, Proc> =>
  write(
    workTree,
    ["pr", "merge", String(number), `--${strategy}`, ...(auto ? ["--auto"] : []), "--repo", repo],
    "gh pr merge failed",
  );

/** `draft: false` marks the PR ready for review; `true` converts it back to a draft. */
export const setPrDraft = (
  workTree: string,
  repo: string,
  number: number,
  draft: boolean,
): Effect.Effect<void, PrActionError, Proc> =>
  write(
    workTree,
    ["pr", "ready", String(number), ...(draft ? ["--undo"] : []), "--repo", repo],
    "gh pr ready failed",
  );

export const closePr = (
  workTree: string,
  repo: string,
  number: number,
): Effect.Effect<void, PrActionError, Proc> =>
  write(workTree, ["pr", "close", String(number), "--repo", repo], "gh pr close failed");

export const reopenPr = (
  workTree: string,
  repo: string,
  number: number,
): Effect.Effect<void, PrActionError, Proc> =>
  write(workTree, ["pr", "reopen", String(number), "--repo", repo], "gh pr reopen failed");

/** Merges the base branch into the PR's head on GitHub; GitHub refuses when they conflict. */
export const updatePrBranch = (
  workTree: string,
  repo: string,
  number: number,
): Effect.Effect<void, PrActionError, Proc> =>
  write(
    workTree,
    ["pr", "update-branch", String(number), "--repo", repo],
    "gh pr update-branch failed",
  );

const STRATEGY_FIELDS = [
  ["squash", "squashMergeAllowed"],
  ["merge", "mergeCommitAllowed"],
  ["rebase", "rebaseMergeAllowed"],
] as const;

export const repoMergeSettings = (
  workTree: string,
  repo: string,
): Effect.Effect<RepoMergeSettings, PrActionError, Proc> =>
  Effect.gen(function* () {
    const fields = STRATEGY_FIELDS.map(([, field]) => field).join(",");
    const stdout = yield* run(
      workTree,
      ["repo", "view", repo, "--json", fields],
      "gh repo view failed",
    );
    let body: unknown;
    try {
      body = JSON.parse(stdout);
    } catch {
      return yield* new PrActionError({ message: "gh repo view returned no settings" });
    }
    const settings =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    // `autoMergeAllowed` is a GraphQL field, but not a `gh repo view --json` field.
    // REST exposes it separately; a permission, version or network failure must not block merging.
    const autoMerge = yield* ghApi(workTree, [`repos/${repo}`, "--jq", ".allow_auto_merge"]).pipe(
      Effect.map((out) => out.status === 0 && !out.truncated && out.stdout.trim() === "true"),
      Effect.orElseSucceed(() => false),
    );
    return {
      strategies: STRATEGY_FIELDS.flatMap(([strategy, field]) =>
        settings[field] === true ? [strategy] : [],
      ),
      autoMerge,
    };
  });
