// Who reviews a PR and how it's labelled, over `gh`: review requests, reviewer suggestions and
// label edits. Writes are the caller's explicit action.

import type { PrLabel } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { gh, ghApi, gitFailMsg } from "./exec.ts";
import { prLabels } from "./pr.ts";
import type { Proc } from "./proc.ts";
import { ReviewActionError } from "./review-actions.ts";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arr = (value: unknown): Array<Json> => (Array.isArray(value) ? value.filter(isJson) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?$/;

/** Trimmed, `@`-stripped and de-duplicated; fails on anything that isn't a login or `org/slug`. */
export const reviewerNames = (
  reviewers: ReadonlyArray<string>,
): Effect.Effect<Array<string>, ReviewActionError> => {
  const names = [
    ...new Set(reviewers.map((name) => name.trim().replace(/^@/, "")).filter((n) => n !== "")),
  ];
  if (names.length === 0) {
    return Effect.fail(new ReviewActionError({ message: "Name at least one reviewer" }));
  }
  const bad = names.find((name) => !REVIEWER.test(name));
  return bad === undefined
    ? Effect.succeed(names)
    : Effect.fail(
        new ReviewActionError({ message: `${bad} is not a GitHub login or organization team` }),
      );
};

/** `gh pr edit --add-reviewer`; returns the names sent. */
export const requestReviewers = (
  workTree: string,
  repo: string,
  number: number,
  reviewers: ReadonlyArray<string>,
): Effect.Effect<Array<string>, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const names = yield* reviewerNames(reviewers);
    const out = yield* gh(
      workTree,
      ["pr", "edit", String(number), "--repo", repo, "--add-reviewer", names.join(",")],
      { timeoutMs: 20_000 },
    ).pipe(Effect.mapError((e) => new ReviewActionError({ message: e.message })));
    if (out.status !== 0) {
      return yield* new ReviewActionError({ message: gitFailMsg(out, "gh pr edit failed") });
    }
    return names;
  });

const isBot = (login: string) => login.endsWith("[bot]") || login.endsWith("-bot");

/**
 * Suggestion order: whoever reviewed or was asked to review the recent PRs, most often first, then
 * the remaining collaborators alphabetically. Bots are left out.
 */
export const rankReviewers = (
  recentPrs: unknown,
  collaborators: ReadonlyArray<string>,
): Array<string> => {
  const counts = new Map<string, number>();
  const bump = (login: string) => {
    if (login !== "" && !isBot(login)) counts.set(login, (counts.get(login) ?? 0) + 1);
  };
  for (const pr of arr(recentPrs)) {
    for (const review of arr(pr["latestReviews"])) {
      bump(isJson(review["author"]) ? str(review["author"]["login"]) : "");
    }
    for (const request of arr(pr["reviewRequests"])) {
      if (str(request["__typename"]) !== "Team") bump(str(request["login"]));
    }
  }
  const recent = [...counts].toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const seen = new Set(recent.map(([login]) => login));
  const rest = collaborators
    .filter((login) => login !== "" && !isBot(login) && !seen.has(login))
    .toSorted((a, b) => a.localeCompare(b));
  return [...recent.map(([login]) => login), ...rest];
};

/** Best effort: whatever `gh` can read in time; never fails. */
export const reviewerSuggestions = (
  workTree: string,
  repo: string,
): Effect.Effect<Array<string>, never, Proc> =>
  Effect.gen(function* () {
    const [recent, collaborators] = yield* Effect.all(
      [
        gh(
          workTree,
          [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "all",
            "--limit",
            "30",
            "--json",
            "latestReviews,reviewRequests",
          ],
          { timeoutMs: 15_000 },
        ).pipe(Effect.option),
        // Needs push access; a 403 simply leaves collaborators out.
        ghApi(workTree, [`repos/${repo}/collaborators?per_page=100`, "--jq", ".[].login"], {
          timeoutMs: 15_000,
        }).pipe(Effect.option),
      ],
      { concurrency: 2 },
    );
    let prs: unknown = [];
    if (Option.isSome(recent) && recent.value.status === 0) {
      try {
        prs = JSON.parse(recent.value.stdout);
      } catch {
        prs = [];
      }
    }
    const logins =
      Option.isSome(collaborators) && collaborators.value.status === 0
        ? collaborators.value.stdout.split("\n").map((line) => line.trim())
        : [];
    return rankReviewers(prs, logins);
  });

/** The repository's labels, as `gh label list` reports them. */
export const listRepoLabels = (
  workTree: string,
  repo: string,
): Effect.Effect<Array<PrLabel>, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const out = yield* gh(
      workTree,
      ["label", "list", "--repo", repo, "--limit", "200", "--json", "name,color,description"],
      { timeoutMs: 15_000 },
    ).pipe(Effect.mapError((e) => new ReviewActionError({ message: e.message })));
    if (out.status !== 0) {
      return yield* new ReviewActionError({ message: gitFailMsg(out, "gh label list failed") });
    }
    try {
      return prLabels(JSON.parse(out.stdout));
    } catch {
      return yield* new ReviewActionError({ message: "gh label list returned no labels" });
    }
  });

// `gh` reads each label flag as CSV, so a comma or quote needs quoting.
const labelArg = (name: string) => (/[",]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name);

/** `gh pr edit --add-label` / `--remove-label`, one flag per label. */
export const editPrLabels = (
  workTree: string,
  repo: string,
  number: number,
  change: "add" | "remove",
  labels: ReadonlyArray<string>,
): Effect.Effect<void, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const names = [...new Set(labels.map((name) => name.trim()).filter((name) => name !== ""))];
    if (names.length === 0)
      return yield* new ReviewActionError({ message: "Name at least one label" });
    if (names.some((name) => /[\r\n]/.test(name))) {
      return yield* new ReviewActionError({ message: "A label name can't span lines" });
    }
    const flag = change === "add" ? "--add-label" : "--remove-label";
    const out = yield* gh(
      workTree,
      [
        "pr",
        "edit",
        String(number),
        "--repo",
        repo,
        ...names.flatMap((name) => [flag, labelArg(name)]),
      ],
      { timeoutMs: 20_000 },
    ).pipe(Effect.mapError((e) => new ReviewActionError({ message: e.message })));
    if (out.status !== 0) {
      return yield* new ReviewActionError({ message: gitFailMsg(out, "gh pr edit failed") });
    }
  });
