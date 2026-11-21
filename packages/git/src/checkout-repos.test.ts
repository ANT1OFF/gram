// A checkout's branch lookups name the repository its embedder recorded it as, never one its
// rewritten `origin` names: the lookup runs with the embedder's GitHub access.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CheckoutRepos } from "./checkout-repos.ts";
import { Pr, PR_INPUTS_REV_PARSE, PrLive } from "./pr.ts";
import { Proc, type ProcOutput, type ProcShape } from "./proc.ts";
import { ReviewBots } from "./review-bots.ts";
import { Tools } from "./tools.ts";

const INPUTS = PR_INPUTS_REV_PARSE.join(" ");
const none: ProcOutput = { status: 1, stdout: "", stderr: "", truncated: false };

/** A checkout on branch `feature`, never pushed, whose origin now names someone/private. */
const rewrittenProc = () => {
  const ghArgs: Array<string> = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync((): ProcOutput => {
        const joined = args.join(" ");
        if (bin === "gh") {
          ghArgs.push(joined);
          return { status: 0, stdout: JSON.stringify({ data: {} }), stderr: "", truncated: false };
        }
        if (joined === INPUTS)
          return {
            status: 128,
            stdout: "/repo\naaa\n",
            stderr: "fatal: no upstream configured for branch",
            truncated: false,
          };
        if (joined === "rev-parse --abbrev-ref HEAD")
          return { status: 0, stdout: "feature\n", stderr: "", truncated: false };
        if (joined === "config --get remote.origin.url")
          return {
            status: 0,
            stdout: "https://github.com/someone/private.git\n",
            stderr: "",
            truncated: false,
          };
        return none;
      }),
  };
  return { proc, ghArgs };
};

const recorded = Layer.effect(
  CheckoutRepos,
  Effect.gen(function* () {
    const repos = yield* CheckoutRepos;
    repos.answerWith(() => Effect.succeed("acme/web"));
    return repos;
  }),
).pipe(Layer.provide(CheckoutRepos.layer));

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
    Layer.provide(recorded),
  );

describe("a checkout's branch lookup", () => {
  it.effect("names the repository its embedder recorded, not the one its origin names now", () =>
    Effect.gen(function* () {
      const { proc, ghArgs } = rewrittenProc();
      yield* Pr.pipe(
        Effect.flatMap((pr) => pr.status("/repo")),
        Effect.ignore,
        Effect.provide(prLayer(proc)),
      );
      expect(ghArgs.length).toBeGreaterThan(0);
      expect(ghArgs.join("\n")).toContain("acme");
      expect(ghArgs.join("\n")).not.toContain("someone");
    }),
  );
});
