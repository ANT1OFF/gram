import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  closePr,
  mergePr,
  reopenPr,
  repoMergeSettings,
  setPrDraft,
  updatePrBranch,
} from "./pr-actions.ts";
import { ProcTimeout } from "./errors.ts";
import { Proc } from "./proc.ts";

type Reply = { status?: number; stdout?: string; stderr?: string };

/** A `gh` that records each call and answers with `reply`. */
const fakeGh = (reply: Reply | ((args: ReadonlyArray<string>) => Reply) = {}) => {
  const calls: Array<{ args: ReadonlyArray<string>; cwd: string | undefined }> = [];
  const provide = Effect.provideService(Proc, {
    run: (bin, args, options) =>
      Effect.sync(() => {
        calls.push({ args: [bin, ...args], cwd: options?.cwd });
        const out = typeof reply === "function" ? reply(args) : reply;
        return {
          status: out.status ?? 0,
          stdout: out.stdout ?? "",
          stderr: out.stderr ?? "",
          truncated: false,
        };
      }),
  });
  return { calls, provide };
};

describe("pr actions", () => {
  it.effect("merge, ready, close and reopen name the PR and its repo", () =>
    Effect.gen(function* () {
      const { calls, provide } = fakeGh();
      yield* provide(mergePr("/wt", "acme/web", 12, "squash", true));
      yield* provide(mergePr("/wt", "acme/web", 12, "rebase", false));
      yield* provide(setPrDraft("/wt", "acme/web", 12, false));
      yield* provide(setPrDraft("/wt", "acme/web", 12, true));
      yield* provide(closePr("/wt", "acme/web", 12));
      yield* provide(reopenPr("/wt", "acme/web", 12));
      yield* provide(updatePrBranch("/wt", "acme/web", 12));
      expect(calls.map((call) => call.args)).toEqual([
        ["gh", "pr", "merge", "12", "--squash", "--auto", "--repo", "acme/web"],
        ["gh", "pr", "merge", "12", "--rebase", "--repo", "acme/web"],
        ["gh", "pr", "ready", "12", "--repo", "acme/web"],
        ["gh", "pr", "ready", "12", "--undo", "--repo", "acme/web"],
        ["gh", "pr", "close", "12", "--repo", "acme/web"],
        ["gh", "pr", "reopen", "12", "--repo", "acme/web"],
        ["gh", "pr", "update-branch", "12", "--repo", "acme/web"],
      ]);
      expect(calls.every((call) => call.cwd === "/wt")).toBe(true);
    }),
  );

  it.effect("fails with what gh said", () =>
    Effect.gen(function* () {
      const { provide } = fakeGh({
        status: 1,
        stderr: "Pull request acme/web#12 is not mergeable\n",
      });
      expect(
        yield* provide(mergePr("/wt", "acme/web", 12, "merge", false)).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "PrActionError",
        message: "Pull request acme/web#12 is not mergeable",
      });
    }),
  );

  it.effect("loads merge-dialog settings with gh that rejects unknown repo JSON fields", () =>
    Effect.gen(function* () {
      const settings = {
        squashMergeAllowed: true,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: true,
      };
      const { calls, provide } = fakeGh((args) => {
        if (args[0] === "api") return { stdout: "true\n" };
        const fields = args[args.indexOf("--json") + 1]!.split(",");
        const unknown = fields.find((field) => !Object.hasOwn(settings, field));
        return unknown === undefined
          ? { stdout: JSON.stringify(settings) }
          : { status: 1, stderr: `Unknown JSON field: "${unknown}"` };
      });
      expect(yield* provide(repoMergeSettings("/wt", "acme/web"))).toEqual({
        strategies: ["squash", "rebase"],
        autoMerge: true,
      });
      expect(calls.map((call) => call.args)).toEqual([
        [
          "gh",
          "repo",
          "view",
          "acme/web",
          "--json",
          "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
        ],
        ["gh", "api", "repos/acme/web", "--jq", ".allow_auto_merge", "--include"],
      ]);
      expect(calls.every((call) => call.cwd === "/wt")).toBe(true);
    }),
  );

  for (const reply of [
    { status: 1, stderr: "HTTP 403: Forbidden" },
    { status: 1, stderr: "HTTP 429: Too Many Requests", stdout: "true" },
    { stdout: "false" },
    { stdout: "null" },
    { stdout: "" },
    { stdout: '"true"' },
    { stdout: "not json" },
  ]) {
    it.effect(`keeps manual merge available when auto-merge reads ${JSON.stringify(reply)}`, () =>
      Effect.gen(function* () {
        const { provide } = fakeGh((args) =>
          args[0] === "api"
            ? reply
            : { stdout: JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true }) },
        );
        expect(yield* provide(repoMergeSettings("/wt", "acme/web"))).toEqual({
          strategies: ["squash", "merge"],
          autoMerge: false,
        });
      }),
    );
  }

  it.effect("keeps manual merge available when the optional auto-merge read times out", () =>
    Effect.gen(function* () {
      const settings = yield* repoMergeSettings("/wt", "acme/web").pipe(
        Effect.provideService(Proc, {
          run: (_bin, args) =>
            args[0] === "api"
              ? Effect.fail(new ProcTimeout({ bin: "gh", message: "timed out" }))
              : Effect.succeed({
                  status: 0,
                  stdout: JSON.stringify({ rebaseMergeAllowed: true }),
                  stderr: "",
                  truncated: false,
                }),
        }),
      );
      expect(settings).toEqual({ strategies: ["rebase"], autoMerge: false });
    }),
  );

  it.effect("preserves repository settings errors and does not invent merge strategies", () =>
    Effect.gen(function* () {
      const denied = fakeGh({ status: 1, stderr: "HTTP 404: Not Found" });
      expect(
        yield* denied.provide(repoMergeSettings("/wt", "acme/web")).pipe(Effect.flip),
      ).toMatchObject({ message: "HTTP 404: Not Found" });
      expect(denied.calls).toHaveLength(1);

      const garbled = fakeGh({ stdout: "not json" });
      expect(
        yield* garbled.provide(repoMergeSettings("/wt", "acme/web")).pipe(Effect.flip),
      ).toMatchObject({ message: "gh repo view returned no settings" });

      const disabled = fakeGh({ stdout: "{}" });
      expect(yield* disabled.provide(repoMergeSettings("/wt", "acme/web"))).toEqual({
        strategies: [],
        autoMerge: false,
      });
    }),
  );
});
