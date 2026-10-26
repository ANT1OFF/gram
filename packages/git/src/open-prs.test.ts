import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { fetchOpenPrs, OPEN_PRS_QUERY, parseOpenPrs } from "./open-prs.ts";
import { Proc, type ProcShape } from "./proc.ts";

const node = (number: number, headRefName: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  headRefName,
  isCrossRepository: false,
  ...extra,
});

const body = (nodes: ReadonlyArray<unknown>) => ({
  data: { repository: { pullRequests: { nodes } } },
});

const mockGh = (reply: { status: number; stdout: string; stderr?: string }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync(() => {
        if (bin === "gh") calls.push(args);
        return { stderr: "", truncated: false, ...reply };
      }),
  };
  return { calls, provide: Effect.provideService(Proc, proc) };
};

describe("parseOpenPrs", () => {
  it("lists the repo's own branches and leaves a fork's PR out", () => {
    expect(
      parseOpenPrs(body([node(4, "feat/a"), node(5, "feat/a", { isCrossRepository: true })])),
    ).toEqual([
      { number: 4, title: "PR 4", url: "https://github.com/acme/web/pull/4", branch: "feat/a" },
    ]);
  });

  it("reads a body without a PR list as unknown, not as none", () => {
    expect(parseOpenPrs(body([]))).toEqual([]);
    expect(parseOpenPrs({ errors: [{ type: "RATE_LIMIT" }] })).toBeUndefined();
    expect(parseOpenPrs({ data: { repository: null } })).toBeUndefined();
    expect(parseOpenPrs("<html>")).toBeUndefined();
  });
});

describe("fetchOpenPrs", () => {
  it.effect("asks for the repo by typed variables, in one request", () =>
    Effect.gen(function* () {
      const gh = mockGh({ status: 0, stdout: JSON.stringify(body([node(4, "feat/a")])) });
      const prs = yield* fetchOpenPrs("/repo", "acme/web").pipe(gh.provide);
      expect(prs.map((pr) => pr.number)).toEqual([4]);
      expect(gh.calls).toEqual([
        [
          "api",
          "graphql",
          "-f",
          `query=${OPEN_PRS_QUERY}`,
          "-f",
          "o=acme",
          "-f",
          "n=web",
          "--include",
        ],
      ]);
    }),
  );

  it.effect("fails with GitHub's words when the document is refused", () =>
    Effect.gen(function* () {
      const gh = mockGh({
        status: 1,
        stdout: JSON.stringify({ errors: [{ type: "RATE_LIMIT" }] }),
        stderr: "gh: API rate limit already exceeded for user ID 1.",
      });
      const error = yield* fetchOpenPrs("/repo", "acme/web").pipe(gh.provide, Effect.flip);
      expect(error.rateLimit).toEqual({ kind: "primary" });
    }),
  );
});
