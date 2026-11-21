// A `gh` read made for one caller carries that caller's environment, and no answer read for one
// caller reaches another: an embedder that answers GitHub per caller relies on both.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { asGhCaller } from "./gh-caller.ts";
import { Pr, PrLive } from "./pr.ts";
import { Proc, type ProcOutput, type ProcShape } from "./proc.ts";
import { ReviewBots } from "./review-bots.ts";
import { Tools } from "./tools.ts";

const pullRequest = {
  number: 7,
  state: "OPEN",
  isCrossRepository: false,
  url: "https://github.com/acme/web/pull/7",
  headRefOid: "tip",
  title: "t",
};
const DOCUMENT = JSON.stringify({ data: { e0: { pullRequest }, e1: { pullRequest } } });

/** A `gh` that answers every document with PR 7, noting the environment each run carried. */
const recordingProc = () => {
  const ghRuns: Array<Readonly<Record<string, string>>> = [];
  const proc: ProcShape = {
    run: (bin, _args, options) =>
      Effect.sync((): ProcOutput => {
        if (bin !== "gh") return { status: 1, stdout: "", stderr: "", truncated: false };
        ghRuns.push(options?.env ?? {});
        return { status: 0, stdout: DOCUMENT, stderr: "", truncated: false };
      }),
  };
  return { proc, ghRuns };
};

const prLayer = (proc: ProcShape) =>
  PrLive.pipe(
    Layer.provide(Layer.succeed(Proc, proc)),
    Layer.provide(
      Layer.succeed(Tools, {
        present: () => Effect.succeed(true),
        ghReady: Effect.succeed(true),
        check: Effect.succeed({ git: true, gh: true, claude: true, ghAuthed: true }),
      }),
    ),
    Layer.provide(ReviewBots.layer),
  );

const ONE = { GH_TOKEN: "caller-one" };
const TWO = { GH_TOKEN: "caller-two" };
const BOUND = { repo: "acme/web", number: 7 } as const;

describe("a gh read made for a caller", () => {
  it.effect("goes out under that caller alone, batched only with its own lookups", () =>
    Effect.gen(function* () {
      const { proc, ghRuns } = recordingProc();
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const read = pr.status("/repo", BOUND);
        yield* Effect.all([asGhCaller(ONE)(read), asGhCaller(TWO)(read), read], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(prLayer(proc)));
      const tokens = ghRuns.map((env) => env["GH_TOKEN"] ?? "none").toSorted();
      expect(tokens).toEqual(["caller-one", "caller-two", "none"]);
    }),
  );

  it.effect("is never answered from what was read for another caller", () =>
    Effect.gen(function* () {
      const { proc, ghRuns } = recordingProc();
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const read = pr.status("/repo", BOUND);
        yield* read;
        yield* asGhCaller(ONE)(read);
        // Its own answer, within the TTL, is reused.
        yield* asGhCaller(ONE)(read);
        yield* asGhCaller(TWO)(read);
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghRuns.map((env) => env["GH_TOKEN"] ?? "none")).toEqual([
        "none",
        "caller-one",
        "caller-two",
      ]);
    }),
  );
});
