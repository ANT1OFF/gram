import { describe, expect, it } from "@effect/vitest";
import { invalidatePrBadges, OpenPrsError, type OpenPr } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { OPEN_PRS_TTL, OpenPrs } from "./open-prs.ts";

const pr: OpenPr = {
  number: 4,
  title: "PR 4",
  url: "https://github.com/acme/web/pull/4",
  branch: "feat/a",
};

const counting = (answer: () => Effect.Effect<ReadonlyArray<OpenPr>, OpenPrsError>) => {
  const fetched: Array<string> = [];
  const layer = OpenPrs.layerFrom(
    (cwd) => Effect.succeed(cwd.startsWith("/none") ? undefined : "Acme/Web"),
    (_cwd, repo) => {
      fetched.push(repo);
      return answer();
    },
  );
  return { fetched, layer };
};

describe("OpenPrs", () => {
  it.effect("asks once per repo however many checkouts ask, until the list ages out", () => {
    const { fetched, layer } = counting(() => Effect.succeed([pr]));
    return Effect.gen(function* () {
      const openPrs = yield* OpenPrs;
      expect(yield* openPrs.list("/repo")).toEqual([pr]);
      expect(yield* openPrs.list("/repo/.worktrees/a")).toEqual([pr]);
      expect(fetched).toHaveLength(1);

      yield* TestClock.adjust(Duration.sum(OPEN_PRS_TTL, Duration.seconds(1)));
      yield* openPrs.list("/repo");
      expect(fetched).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks again after a PR write", () => {
    const { fetched, layer } = counting(() => Effect.succeed([pr]));
    return Effect.gen(function* () {
      const openPrs = yield* OpenPrs;
      yield* openPrs.list("/repo");
      invalidatePrBadges();
      yield* openPrs.list("/repo");
      expect(fetched).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers unknown, and keeps nothing, when the request fails or no repo applies", () => {
    const { fetched, layer } = counting(() =>
      Effect.fail(new OpenPrsError({ message: "API rate limit exceeded" })),
    );
    return Effect.gen(function* () {
      const openPrs = yield* OpenPrs;
      expect(yield* openPrs.list("/repo")).toBeUndefined();
      expect(yield* openPrs.list("/repo")).toBeUndefined();
      expect(fetched).toHaveLength(2);
      expect(yield* openPrs.list("/none")).toBeUndefined();
      expect(fetched).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
});
