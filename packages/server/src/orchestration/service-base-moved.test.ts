// Orchestration service: what the other workers hear when one worker's pull request merges.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit, run } from "../git/test-repo.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitSent,
  withServer,
} from "./test-harness.ts";

const badge = (number: number, state: "OPEN" | "MERGED" = "OPEN") =>
  prBadge({ number, state, url: `https://github.com/acme/shop/pull/${number}` });

describe.skipIf(!hasGit)("orchestration service: a sibling's merge", () => {
  it.effect(
    "rechecks the other open PRs at once, and tells a worker sharing files to bring the base in",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { session } = yield* openOrchestrator(world);
            const merging = yield* spawn(session, { feature: "mail", title: "Mail" });
            const sharing = yield* spawn(session, { feature: "billing", title: "Billing" });
            const apart = yield* spawn(session, { feature: "search", title: "Search" });
            for (const worker of [merging, sharing, apart]) {
              yield* worker.session.callTool("report", { state: "progress", summary: "Started." });
              yield* completeTurn(worker.session);
            }
            for (const [worker, file, text] of [
              [merging, "shared.ts", "a\n"],
              [sharing, "shared.ts", "b\n"],
              [apart, "search.ts", "c\n"],
            ] as const) {
              fs.writeFileSync(nodePath.join(worker.thread.checkout.path, file), text);
              run(worker.thread.checkout.path, "add", file);
            }
            yield* publishGit(world, merging.thread, {
              changesToken: "t1",
              changedFiles: 1,
              pr: badge(21),
            });
            yield* publishGit(world, sharing.thread, {
              changesToken: "t1",
              changedFiles: 1,
              pr: badge(22),
            });
            yield* publishGit(world, apart.thread, {
              changesToken: "t1",
              changedFiles: 1,
              pr: badge(23),
            });
            world.refreshed.length = 0;
            const sentBefore = apart.session.sent.length;

            yield* publishGit(world, merging.thread, {
              changesToken: "t1",
              changedFiles: 1,
              pr: badge(21, "MERGED"),
            });

            expect(world.refreshed.toSorted()).toEqual(
              [sharing.thread.checkout.path, apart.thread.checkout.path].toSorted(),
            );
            const told = yield* waitSent(sharing.thread.id, 2);
            const text = told.sent.at(-1)?.text ?? "";
            expect(text).toContain("https://github.com/acme/shop/pull/21");
            expect(text).toContain("`shared.ts`");
            expect(text).toContain("even if git reports no conflict");
            yield* settle;
            expect(apart.session.sent).toHaveLength(sentBefore);
          }),
        );
      }),
  );
});
