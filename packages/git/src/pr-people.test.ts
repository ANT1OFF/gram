import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  editPrLabels,
  listRepoLabels,
  rankReviewers,
  requestReviewers,
  reviewerNames,
  reviewerSuggestions,
} from "./pr-people.ts";
import { Proc, type ProcShape } from "./proc.ts";

type Reply = { status: number; stdout?: string; stderr?: string };

const mockProc = (respond: (args: ReadonlyArray<string>) => Reply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (_bin, args) =>
      Effect.sync(() => {
        calls.push(args);
        const reply = respond(args);
        return { stdout: "", stderr: "", truncated: false, ...reply };
      }),
  };
  return { proc, calls };
};

describe("reviewerNames", () => {
  it.effect("trims, strips @ and de-duplicates", () =>
    Effect.gen(function* () {
      expect(yield* reviewerNames([" @alice", "alice", "example/platform", ""])).toEqual([
        "alice",
        "example/platform",
      ]);
    }),
  );

  it.effect("refuses an empty list and anything that isn't a login or org/team", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.exit(reviewerNames([" "]));
      const bad = yield* Effect.flip(reviewerNames(["alice", "--add-label=x"]));
      expect(Exit.isFailure(empty)).toBe(true);
      expect(bad.message).toBe("--add-label=x is not a GitHub login or organization team");
    }),
  );
});

describe("requestReviewers", () => {
  it.effect("adds every reviewer in one gh pr edit", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc(() => ({ status: 0 }));
      const sent = yield* requestReviewers("/w", "acme/web", 12, ["alice", "acme/core"]).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(sent).toEqual(["alice", "acme/core"]);
      expect(calls).toEqual([
        ["pr", "edit", "12", "--repo", "acme/web", "--add-reviewer", "alice,acme/core"],
      ]);
    }),
  );

  it.effect("fails with what gh said", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stderr: "could not request reviewer: bob\n" }));
      const error = yield* Effect.flip(
        requestReviewers("/w", "acme/web", 12, ["bob"]).pipe(Effect.provideService(Proc, proc)),
      );
      expect(error.message).toBe("could not request reviewer: bob");
    }),
  );
});

describe("reviewer suggestions", () => {
  const recent = [
    {
      latestReviews: [{ author: { login: "sam" } }, { author: { login: "ci[bot]" } }],
      reviewRequests: [{ __typename: "User", login: "priya" }],
    },
    {
      latestReviews: [{ author: { login: "sam" } }],
      reviewRequests: [{ __typename: "Team", name: "Core", slug: "acme/core" }],
    },
  ];

  it("ranks recent reviewers by frequency, then the other collaborators", () => {
    expect(rankReviewers(recent, ["zed", "sam", "adam", "deploy-bot"])).toEqual([
      "sam",
      "priya",
      "adam",
      "zed",
    ]);
  });

  it.effect("still suggests recent reviewers when collaborators need push access", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc((args) =>
        args[0] === "api"
          ? { status: 1, stderr: "HTTP 403" }
          : { status: 0, stdout: JSON.stringify(recent) },
      );
      const logins = yield* reviewerSuggestions("/w", "acme/web").pipe(
        Effect.provideService(Proc, proc),
      );
      expect(logins).toEqual(["sam", "priya"]);
      expect(calls.map((args) => args[0])).toEqual(["pr", "api"]);
    }),
  );
});

describe("PR labels", () => {
  it.effect("lists the repository's labels", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc(() => ({
        status: 0,
        stdout: JSON.stringify([{ name: "bug", color: "d73a4a", description: "Broken" }]),
      }));
      const labels = yield* listRepoLabels("/w", "acme/web").pipe(
        Effect.provideService(Proc, proc),
      );
      expect(labels).toEqual([{ name: "bug", color: "d73a4a", description: "Broken" }]);
      expect(calls[0]).toEqual([
        "label",
        "list",
        "--repo",
        "acme/web",
        "--limit",
        "200",
        "--json",
        "name,color,description",
      ]);
    }),
  );

  it.effect("passes one flag per label, quoting a comma for gh's CSV parsing", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc(() => ({ status: 0 }));
      yield* editPrLabels("/w", "acme/web", 7, "remove", ["bug", "bug", "needs, triage"]).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(calls[0]).toEqual([
        "pr",
        "edit",
        "7",
        "--repo",
        "acme/web",
        "--remove-label",
        "bug",
        "--remove-label",
        '"needs, triage"',
      ]);
    }),
  );

  it.effect("fails with what gh said when a label doesn't exist", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stderr: "'nope' not found\n" }));
      const error = yield* Effect.flip(
        editPrLabels("/w", "acme/web", 7, "add", ["nope"]).pipe(Effect.provideService(Proc, proc)),
      );
      expect(error.message).toBe("'nope' not found");
    }),
  );
});
