const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import { Proc, type ProcShape } from "./proc.ts";
import {
  applySuggestion,
  fetchPrReview,
  invalidatePrReviews,
  postPrComment,
  prTargetOf,
  replyToThread,
  repoFromPrUrl,
  resolveThread,
} from "./review-actions.ts";
import { removeDir, tempDir } from "./test-utils.ts";

type Reply = { status: number; stdout: string; stderr?: string };

/** A Proc answering every `gh` call from `respond`, recording the argv. */
const mockGh = (respond: (args: ReadonlyArray<string>) => Reply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (_bin, args) =>
      Effect.sync(() => {
        calls.push(args);
        const reply = respond(args);
        return { stderr: "", truncated: false, ...reply };
      }),
  };
  return { calls, provide: Effect.provideService(Proc, proc) };
};

const fixtureNode = (name: string) =>
  JSON.parse(
    fs.readFileSync(new URL(`./fixtures/review-bot/${name}.json`, import.meta.url), "utf8"),
  );

describe("review actions over gh", () => {
  beforeEach(() => invalidatePrReviews());

  it.effect("fetch the full review for a PR with typed number variables", () =>
    Effect.gen(function* () {
      const { calls, provide } = mockGh(() => ({
        status: 0,
        stdout: JSON.stringify(fixtureNode("changes-requested")),
      }));
      const review = yield* provide(fetchPrReview("/tmp", "acme/web", 1943, REVIEW_BOT_FIXTURE));
      expect(calls.find((args) => args.includes("graphql"))).toEqual(
        expect.arrayContaining(["-f", "o=acme", "-f", "n=web", "-F", "num=1943"]),
      );
      expect(review.pr).toMatchObject({ number: 1943, reviewDecision: "CHANGES_REQUESTED" });
      expect(review.state?.threads.blockers).toBe(2);
      expect(review.latestReview?.meta?.scope).toBe("interdiff");
      expect(review.threads).toHaveLength(8);
    }),
  );

  it.effect("surface GraphQL errors and bad repositories as ReviewActionError", () =>
    Effect.gen(function* () {
      const { provide } = mockGh(() => ({
        status: 1,
        stdout: JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }),
      }));
      const missing = yield* provide(
        fetchPrReview("/tmp", "acme/gone", 1, REVIEW_BOT_FIXTURE),
      ).pipe(Effect.flip);
      expect(missing).toMatchObject({
        _tag: "ReviewActionError",
        message: "Could not resolve to a Repository",
      });
      const invalid = yield* provide(
        fetchPrReview("/tmp", "not-a-repo", 1, REVIEW_BOT_FIXTURE),
      ).pipe(Effect.flip);
      expect(invalid.message).toBe("invalid repository not-a-repo");
    }),
  );

  it.effect("serves back-to-back review reads from one gh spawn, per checkout HEAD", () =>
    Effect.gen(function* () {
      let head = "aaa";
      const calls: Array<ReadonlyArray<string>> = [];
      const proc: ProcShape = {
        run: (bin, args) =>
          Effect.sync(() => {
            calls.push(args);
            const stdout = bin === "git" ? head : JSON.stringify(fixtureNode("changes-requested"));
            return { status: 0, stdout, stderr: "", truncated: false };
          }),
      };
      const provide = Effect.provideService(Proc, proc);
      const read = () => provide(fetchPrReview("/tmp", "acme/web", 1943, REVIEW_BOT_FIXTURE));
      const graphqlCalls = () => calls.filter((args) => args.includes("graphql")).length;

      // The state read an agent makes, then the threads read it makes right after.
      yield* Effect.all([read(), read()], { concurrency: "unbounded" });
      yield* read();
      expect(graphqlCalls()).toBe(1);

      head = "bbb";
      yield* read();
      expect(graphqlCalls()).toBe(2);

      yield* provide(resolveThread("/tmp", "PRRT_1")).pipe(Effect.ignore);
      yield* read();
      expect(graphqlCalls()).toBe(4);
    }),
  );

  it.effect("never caches a failed review read", () =>
    Effect.gen(function* () {
      const { calls, provide } = mockGh((args) =>
        args.includes("graphql")
          ? { status: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded" }
          : { status: 0, stdout: "aaa" },
      );
      for (let i = 0; i < 2; i++) {
        const error = yield* provide(fetchPrReview("/tmp", "acme/web", 1, REVIEW_BOT_FIXTURE)).pipe(
          Effect.flip,
        );
        expect(error.rateLimit).toEqual({ kind: "primary" });
      }
      expect(calls.filter((args) => args.includes("graphql"))).toHaveLength(2);
    }),
  );

  it.effect("reply, resolve and post a re-review command", () =>
    Effect.gen(function* () {
      const { calls, provide } = mockGh((args) => {
        if (
          args.includes("api") &&
          args[1] === "graphql" &&
          args.some((a) => a.startsWith("query=mutation($t:ID!,$b"))
        ) {
          return {
            status: 0,
            stdout: JSON.stringify({
              data: {
                addPullRequestReviewThreadReply: {
                  comment: {
                    id: "PRRC_9",
                    author: { login: "human-1" },
                    body: "Fixed in 3f9c2d1",
                    createdAt: "2026-09-16T10:00:00Z",
                    url: "https://github.com/acme/web/pull/12#discussion_r9",
                  },
                },
              },
            }),
          };
        }
        if (args[1] === "graphql") {
          return {
            status: 0,
            stdout: JSON.stringify({
              data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } },
            }),
          };
        }
        return { status: 0, stdout: "{}" };
      });

      const reply = yield* provide(replyToThread("/tmp", "PRRT_1", "Fixed in 3f9c2d1"));
      expect(reply).toEqual({
        id: "PRRC_9",
        author: "human-1",
        body: "Fixed in 3f9c2d1",
        createdAt: "2026-09-16T10:00:00Z",
        url: "https://github.com/acme/web/pull/12#discussion_r9",
      });
      expect(calls[0]).toEqual(
        expect.arrayContaining(["-f", "t=PRRT_1", "-f", "b=Fixed in 3f9c2d1"]),
      );

      yield* provide(resolveThread("/tmp", "PRRT_1"));
      expect(calls[1]).toEqual(expect.arrayContaining(["-f", "t=PRRT_1"]));

      yield* provide(postPrComment("/tmp", "acme/web", 12, "/agent review"));
      expect(calls[2]).toEqual([
        "api",
        "repos/acme/web/issues/12/comments",
        "-f",
        "body=/agent review",
        "--include",
      ]);

      expect(
        (yield* provide(replyToThread("/tmp", "PRRT_1", "  ")).pipe(Effect.flip)).message,
      ).toBe("the reply is empty");
    }),
  );

  it("parse the repository from a PR url", () => {
    expect(repoFromPrUrl("https://github.com/acme/web/pull/12")).toBe("acme/web");
    expect(repoFromPrUrl("https://organization.example.invalid/org/repo/pull/7/files")).toBe(
      "org/repo",
    );
    expect(repoFromPrUrl("https://organization.example.invalid/org/api.v2/pull/12/")).toBe(
      "org/api.v2",
    );
    expect(repoFromPrUrl("https://github.com/acme/web")).toBeUndefined();
  });

  it("act on the bound PR, else the branch badge's PR", () => {
    const badge = { number: 7, url: "https://github.com/acme/web/pull/7" };
    expect(prTargetOf({ repo: "acme/api", number: 12 }, badge)).toEqual({
      repo: "acme/api",
      number: 12,
    });
    expect(prTargetOf(undefined, badge)).toEqual({ repo: "acme/web", number: 7 });
    expect(prTargetOf(undefined, { number: 7, url: "not a PR url" })).toBeUndefined();
    expect(prTargetOf(undefined, undefined)).toBeUndefined();
  });
});

const target = (line: number | undefined, startLine?: number, isOutdated = false) => ({
  path: "src/a.py",
  line,
  startLine,
  isOutdated,
});

const read = (dir: string, path = "src/a.py") => fs.readFileSync(nodePath.join(dir, path), "utf8");

describe("applySuggestion", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });
  const workTree = (files: Record<string, string>) => {
    const dir = tempDir();
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
      fs.mkdirSync(nodePath.dirname(nodePath.join(dir, path)), { recursive: true });
      fs.writeFileSync(nodePath.join(dir, path), content);
    }
    return dir;
  };

  it.effect("replaces one line, a range, or deletes lines, keeping the trailing newline", () =>
    Effect.gen(function* () {
      const dir = workTree({ "src/a.py": "one\ntwo\nthree\nfour\n" });
      expect(yield* applySuggestion(dir, target(2), "TWO")).toEqual({
        path: "src/a.py",
        startLine: 2,
        endLine: 2,
      });
      expect(read(dir)).toBe("one\nTWO\nthree\nfour\n");
      yield* applySuggestion(dir, target(4, 3), "tail a\ntail b");
      expect(read(dir)).toBe("one\nTWO\ntail a\ntail b\n");
      yield* applySuggestion(dir, target(1), "");
      expect(read(dir)).toBe("TWO\ntail a\ntail b\n");
    }),
  );

  it.effect("keeps CRLF line endings", () =>
    Effect.gen(function* () {
      const dir = workTree({ "src/a.py": "a\r\nb\r\n" });
      yield* applySuggestion(dir, target(2), "B");
      expect(read(dir)).toBe("a\r\nB\r\n");
    }),
  );

  it.effect("refuses outdated suggestions, missing lines, and paths outside the checkout", () =>
    Effect.gen(function* () {
      const dir = workTree({ "src/a.py": "a\n" });
      const outdated = yield* applySuggestion(dir, target(undefined, undefined, true), "x").pipe(
        Effect.flip,
      );
      expect(outdated.message).toBe("This suggestion is on outdated code; apply it by hand.");
      const range = yield* applySuggestion(dir, target(5), "x").pipe(Effect.flip);
      expect(range.message).toBe("src/a.py no longer has lines 5–5");
      const escape = yield* applySuggestion(
        dir,
        { ...target(1), path: "../elsewhere.py" },
        "x",
      ).pipe(Effect.flip);
      expect(escape.message).toBe("../elsewhere.py is a link or outside the checkout");
      expect(read(dir)).toBe("a\n");
    }),
  );

  it.effect("replaces the file rather than writing through a hard link to it", () =>
    Effect.gen(function* () {
      const dir = workTree({ "src/a.py": "a\n" });
      const outside = workTree({ "linked.py": "a\n" });
      fs.rmSync(nodePath.join(dir, "src/a.py"));
      fs.linkSync(nodePath.join(outside, "linked.py"), nodePath.join(dir, "src/a.py"));
      yield* applySuggestion(dir, target(1), "b");
      expect(read(dir)).toBe("b\n");
      expect(read(outside, "linked.py")).toBe("a\n");
    }),
  );

  // A symlink on Windows needs a privilege CI doesn't have; file modes are POSIX.
  describe.skipIf(process.platform === "win32")("links and modes", () => {
    it.effect("doesn't read or write through a file the branch made a symlink", () =>
      Effect.gen(function* () {
        const dir = workTree({});
        const outside = workTree({ "target.py": "first\nsecond\n" });
        fs.mkdirSync(nodePath.join(dir, "src"));
        fs.symlinkSync(nodePath.join(outside, "target.py"), nodePath.join(dir, "src/a.py"));
        const error = yield* applySuggestion(dir, target(1), "replaced").pipe(Effect.flip);
        expect(error.message).toBe("src/a.py is a link or outside the checkout");
        expect(read(outside, "target.py")).toBe("first\nsecond\n");
        expect(fs.lstatSync(nodePath.join(dir, "src/a.py")).isSymbolicLink()).toBe(true);
      }),
    );

    it.effect("doesn't write through a directory the branch made a symlink", () =>
      Effect.gen(function* () {
        const dir = workTree({});
        const outside = workTree({ "a.py": "first\n" });
        fs.symlinkSync(outside, nodePath.join(dir, "src"));
        const error = yield* applySuggestion(dir, target(1), "replaced").pipe(Effect.flip);
        expect(error.message).toBe("src/a.py is a link or outside the checkout");
        expect(read(outside, "a.py")).toBe("first\n");
      }),
    );

    it.effect("keeps the file's permission bits", () =>
      Effect.gen(function* () {
        const dir = workTree({ "src/a.py": "#!/bin/sh\n" });
        fs.chmodSync(nodePath.join(dir, "src/a.py"), 0o755);
        yield* applySuggestion(dir, target(1), "#!/bin/bash");
        expect(read(dir)).toBe("#!/bin/bash\n");
        expect(fs.statSync(nodePath.join(dir, "src/a.py")).mode & 0o777).toBe(0o755);
      }),
    );
  });
});
