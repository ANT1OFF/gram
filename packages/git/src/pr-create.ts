// Opening a pull request for the current branch through `gh`, with a title and body from its commits.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { gh, git, gitFailMsg } from "./exec.ts";
import { invalidatePrBadges } from "./pr-cache.ts";
import type { Proc } from "./proc.ts";
import { repoFromPrUrl } from "./review-actions.ts";

/** `gh pr create` failed, or didn't say which PR it made. */
export class PrCreateFailed extends Data.TaggedError("PrCreateFailed")<{
  readonly message: string;
}> {}

export interface PrDraft {
  readonly title: string;
  readonly body: string;
  /** Commits on the branch since `base`. */
  readonly commits: number;
}

const UNIT = "\x1f";
const RECORD = "\x1e";

/**
 * A PR title and body from the branch's commits since `base`: one commit gives its subject and body,
 * several give `fallbackTitle` and a list of subjects, none give `fallbackTitle` alone.
 */
export const prDraftFromCommits = (
  cwd: string,
  base: string,
  fallbackTitle: string,
): Effect.Effect<PrDraft, never, Proc> =>
  Effect.gen(function* () {
    const out = yield* git(cwd, [
      "log",
      "--reverse",
      `--format=%s${UNIT}%b${RECORD}`,
      `${base}..HEAD`,
    ]).pipe(Effect.option);
    const commits =
      Option.isSome(out) && out.value.status === 0
        ? out.value.stdout
            .split(RECORD)
            .map((entry) => entry.trim())
            .filter((entry) => entry !== "")
            .map((entry) => {
              const [subject = "", body = ""] = entry.split(UNIT);
              return { subject: subject.trim(), body: body.trim() };
            })
        : [];
    const [only] = commits;
    if (commits.length === 1 && only) return { title: only.subject, body: only.body, commits: 1 };
    return {
      title: fallbackTitle,
      body: commits.map((commit) => `- ${commit.subject}`).join("\n"),
      commits: commits.length,
    };
  });

export interface CreatedPr {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

/** Creating a PR talks to GitHub; `gh`'s 10 s default is for status reads. */
const PR_CREATE_TIMEOUT_MS = 60_000;

/** `gh pr create` for the current branch into `base`; resolves with the new PR's repo, number and URL. */
export const createPr = (
  cwd: string,
  input: {
    readonly title: string;
    readonly body: string;
    readonly base: string;
    readonly draft: boolean;
  },
): Effect.Effect<CreatedPr, PrCreateFailed, Proc> =>
  Effect.gen(function* () {
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      // The body goes over stdin: a newline can't pass through `cmd.exe` when `gh` is a batch shim,
      // and a long body can pass Windows' command-line limit.
      "--body-file",
      "-",
      "--base",
      input.base,
      ...(input.draft ? ["--draft"] : []),
    ];
    const out = yield* gh(cwd, args, {
      tier: "network",
      timeoutMs: PR_CREATE_TIMEOUT_MS,
      stdin: input.body,
    }).pipe(Effect.mapError((e) => new PrCreateFailed({ message: e.message })));
    if (out.status !== 0) {
      return yield* new PrCreateFailed({ message: gitFailMsg(out, "gh pr create failed") });
    }
    const url = out.stdout
      .trim()
      .split(/\s+/)
      .findLast((part) => /\/pull\/\d+/.test(part));
    const repo = url === undefined ? undefined : repoFromPrUrl(url);
    const number = url === undefined ? Number.NaN : Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (url === undefined || repo === undefined || !Number.isInteger(number)) {
      return yield* new PrCreateFailed({
        message: `gh pr create didn't print a PR URL: ${out.stdout.trim() || out.stderr.trim()}`,
      });
    }
    invalidatePrBadges();
    return { repo, number, url };
  });
