// GitHub's auto-merge as a merge freeze puts it back: pinned to the head it stood on, so GitHub
// refuses it on a head someone pushed since, and never armed without one.
import { describe, expect, it } from "@effect/vitest";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutoMerges, AutoMergesLive } from "./auto-merges.ts";

const HEAD = "a".repeat(40);

const recording = (stdout = "") => {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = AutoMergesLive.pipe(
    Layer.provide(
      Layer.succeed(Proc, {
        run: (_bin, args) =>
          Effect.sync(() => {
            calls.push(args);
            return { status: 0, stdout, stderr: "", truncated: false };
          }),
      }),
    ),
  );
  return { calls, layer };
};

describe("AutoMerges", () => {
  it.effect("arms an auto-merge again only pinned to a full head commit", () => {
    const { calls, layer } = recording();
    return Effect.gen(function* () {
      const autoMerges = yield* AutoMerges;
      expect(yield* autoMerges.enable("/w", "acme/app", 7, "rebase", HEAD)).toBeUndefined();
      expect(calls).toEqual([
        [
          "pr",
          "merge",
          "7",
          "--auto",
          "--rebase",
          "--match-head-commit",
          HEAD,
          "--repo",
          "acme/app",
        ],
      ]);
      // A head that isn't a full commit id pins nothing, so nothing is armed.
      expect(yield* autoMerges.enable("/w", "acme/app", 7, "rebase", "main")).toBeDefined();
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the head each armed auto-merge stands on", () => {
    const { layer } = recording(
      JSON.stringify([
        { number: 7, headRefOid: HEAD, autoMergeRequest: { mergeMethod: "SQUASH" } },
        { number: 8, headRefOid: null, autoMergeRequest: { mergeMethod: "MERGE" } },
        { number: 9, headRefOid: HEAD, autoMergeRequest: null },
      ]),
    );
    return Effect.gen(function* () {
      const autoMerges = yield* AutoMerges;
      expect(yield* autoMerges.armed("/w", "acme/app", "main")).toEqual([
        { number: 7, method: "squash", head: HEAD },
        { number: 8, method: "merge", head: undefined },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
