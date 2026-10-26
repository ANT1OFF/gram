import { describe, expect, it } from "@effect/vitest";
import { PR_POLL_TTL_MS, Proc, Tools } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { badgeTtlMs, GitServerConfig, gitPlatformTest } from "./platform.ts";

it.effect(
  "the offline platform reports missing gh without probing host accounts or processes",
  () => {
    const calls: string[] = [];
    const proc = Layer.succeed(Proc, {
      run: (bin) =>
        Effect.sync(() => {
          calls.push(bin);
          throw new Error("host process must not run for readiness");
        }),
    });
    return Effect.gen(function* () {
      const tools = yield* Tools;
      expect(yield* tools.check).toEqual({ git: true, gh: false, ghAuthed: false, claude: false });
      expect(yield* tools.ghReady).toBe(false);
      expect(yield* tools.present("codex")).toBe(false);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(gitPlatformTest({ proc })));
  },
);

describe("GitServerConfig.fromEnv", () => {
  it("overrides the sweep cadence and settle delay, ignoring anything that isn't a positive number", () => {
    expect(GitServerConfig.fromEnv({})).toEqual(GitServerConfig.defaults);
    const fast = GitServerConfig.fromEnv({
      GRAM_GIT_SWEEP_MS: "1500",
      GRAM_GIT_SETTLE_MS: "250",
    });
    expect(Duration.toMillis(fast.sweepInterval ?? Duration.zero)).toBe(1500);
    expect(Duration.toMillis(fast.monitorSettleDelay)).toBe(250);
    expect(
      GitServerConfig.fromEnv({
        GRAM_GIT_SWEEP_MS: "soon",
        GRAM_GIT_SETTLE_MS: "-1",
      }),
    ).toEqual(GitServerConfig.defaults);
  });

  it("overrides the babysit quiet window and the review round debounce", () => {
    const fast = GitServerConfig.fromEnv({
      GRAM_BABYSIT_QUIET_MS: "1000",
      GRAM_REVIEW_DEBOUNCE_MS: "400",
    });
    expect(Duration.toMillis(fast.babysitQuietWindow)).toBe(1000);
    expect(Duration.toMillis(fast.reviewRoundDebounce)).toBe(400);
    expect(fast.sweepInterval).toEqual(GitServerConfig.defaults.sweepInterval);
    expect(
      GitServerConfig.fromEnv({
        GRAM_BABYSIT_QUIET_MS: "0",
        GRAM_REVIEW_DEBOUNCE_MS: "",
      }),
    ).toEqual(GitServerConfig.defaults);
  });
});

describe("badgeTtlMs", () => {
  it("keeps the usual TTL at the production cadence, and stays under a faster sweep", () => {
    expect(badgeTtlMs(GitServerConfig.defaults)).toBe(PR_POLL_TTL_MS);
    expect(badgeTtlMs({ ...GitServerConfig.defaults, sweepInterval: undefined })).toBe(
      PR_POLL_TTL_MS,
    );
    const fast = GitServerConfig.fromEnv({ GRAM_GIT_SWEEP_MS: "1500" });
    expect(badgeTtlMs(fast)).toBe(1000);
  });
});
