import { describe, expect, it } from "@effect/vitest";
import { type Checkout, type CheckoutRequest, HostId, InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { prepareWithOthers } from "./create-in-checkout.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");

/** Checkouts as a machine's host makes them, recording what it was asked and what it gave back. */
const fake = (refuse?: string) => {
  const asked: Array<{ request: CheckoutRequest; root: string }> = [];
  const discarded: Array<string> = [];
  return {
    asked,
    discarded,
    deps: {
      prepare: (request: CheckoutRequest, root: string) =>
        Effect.suspend(() => {
          asked.push({ request, root });
          if (root === refuse) return Effect.fail(new InvalidState({ message: `${root} refused` }));
          const checkout: Checkout =
            request.kind === "newWorktree"
              ? {
                  kind: "worktree",
                  path: `/there${root}/.worktrees/${request.branch}`,
                  branch: request.branch,
                  hostId: MACHINE,
                }
              : { kind: "main", path: `/there${root}`, hostId: MACHINE };
          return Effect.succeed(checkout);
        }),
      discard: (checkout: Checkout) => Effect.sync(() => void discarded.push(checkout.path)),
    },
  };
};

describe("prepareWithOthers", () => {
  it.effect("makes the other repositories' worktrees on the thread's machine and branch", () =>
    Effect.gen(function* () {
      const { asked, deps } = fake();
      const place = yield* prepareWithOthers(
        deps,
        { kind: "newWorktree", branch: "feat/x" },
        "/repos/api",
        ["/repos/web"],
      );
      expect(asked[1]).toEqual({
        request: { kind: "newWorktree", branch: "feat/x", hostId: MACHINE },
        root: "/repos/web",
      });
      expect(place.extraCheckouts).toHaveLength(1);
      expect(place.additionalDirectories).toEqual(["/there/repos/web/.worktrees/feat/x"]);
    }),
  );

  it.effect("takes back what it made when another repository refuses", () =>
    Effect.gen(function* () {
      const { discarded, deps } = fake("/repos/docs");
      const refused = yield* prepareWithOthers(
        deps,
        { kind: "newWorktree", branch: "feat/x" },
        "/repos/api",
        ["/repos/web", "/repos/docs"],
      ).pipe(Effect.flip);
      expect(refused).toMatchObject({ message: "/repos/docs refused" });
      expect(discarded).toEqual([
        "/there/repos/api/.worktrees/feat/x",
        "/there/repos/web/.worktrees/feat/x",
      ]);
    }),
  );

  it.effect("refuses folders as they are on another machine, taking its checkout back", () =>
    Effect.gen(function* () {
      const { discarded, deps } = fake();
      const refused = yield* prepareWithOthers(deps, { kind: "current" }, "/repos/api", [
        "/repos/web",
      ]).pipe(Effect.flip);
      expect(refused._tag).toBe("InvalidState");
      expect(discarded).toEqual(["/there/repos/api"]);
    }),
  );
});
