import { describe, expect, it } from "@effect/vitest";
import { ThreadNotFound, type Thread, type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePages } from "../pages/pages.ts";
import { offerPageTool } from "./page-tools.ts";
import { bindAppTools } from "./registry.ts";

const WS = "ws-pages" as WorkspaceId;
const WORKER = "t-worker" as ThreadId;
const SOLO = "t-solo" as ThreadId;

const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-page-tools-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const worktree = join(dir, "worktree");
  mkdirSync(join(worktree, "board"), { recursive: true });
  const entry = join(worktree, "board", "index.html");
  writeFileSync(entry, "<!doctype html><title>Board</title><p>pinned</p>");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "index.html"), "<p>not the thread's</p>");
  const threads: Record<string, Partial<Thread>> = {
    [WORKER]: {
      id: WORKER,
      title: "board-worker",
      workspaceId: WS,
      checkout: { kind: "worktree", path: worktree },
    },
    [SOLO]: { id: SOLO, title: "Solo", checkout: { kind: "main", path: worktree } },
  };
  const store = {
    getThread: (threadId: ThreadId) =>
      threads[threadId] === undefined
        ? Effect.fail(new ThreadNotFound({ threadId }))
        : Effect.succeed(threads[threadId] as Thread),
  };
  const pages = makePages(join(dir, "pages"), () => Effect.void);
  const offer = (threadId: ThreadId) =>
    bindAppTools([offerPageTool(pages, store)], threadId).find(
      (tool) => tool.descriptor.name === "offer_page_version",
    )!;
  return { dir, worktree, entry, pages, offer };
});

describe("offer_page_version", () => {
  it.effect("offers a copy the page doesn't show until the user does", () =>
    Effect.gen(function* () {
      const { entry, pages, offer } = yield* setup;
      // The user's pin, as the Preview tab's Pin calls it.
      const pinned = yield* pages.pin({
        workspaceId: WS,
        by: { threadId: WORKER, title: "board-worker" },
        entry,
      });
      const shownBefore = yield* pages.shown(WS, pinned.id);
      const before = readFileSync(join(shownBefore.folder, "index.html"), "utf8");
      writeFileSync(entry, "<!doctype html><title>Board</title><p>offered</p>");
      const result = yield* offer(WORKER).run({ page: pinned.id, path: entry });
      expect(result).toMatchObject({ page: pinned.id, offered: 2, shown: 1 });
      // Shown as it was pinned; the offer waits for the user.
      const shown = yield* pages.shown(WS, pinned.id);
      expect(shown.version).toBe(1);
      expect(readFileSync(join(shown.folder, "index.html"), "utf8")).toBe(before);
      expect((yield* pages.read(WS, pinned.id)).offer?.version).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a file outside the thread's folders, a solo thread and an unknown page", () =>
    Effect.gen(function* () {
      const { dir, entry, pages, offer } = yield* setup;
      const none = yield* Effect.exit(offer(WORKER).run({ page: "board-000000", path: entry }));
      expect(Exit.isFailure(none) && JSON.stringify(none.cause)).toContain("No page is pinned");
      // Offering never pins: there is still nothing.
      expect(yield* pages.list(WS)).toEqual([]);
      const pinned = yield* pages.pin({
        workspaceId: WS,
        by: { threadId: WORKER, title: "board-worker" },
        entry,
      });
      const outside = yield* Effect.exit(
        offer(WORKER).run({ page: pinned.id, path: join(dir, "elsewhere", "index.html") }),
      );
      expect(Exit.isFailure(outside) && JSON.stringify(outside.cause)).toContain(
        "outside this thread's folders",
      );
      const unknown = yield* Effect.exit(offer(WORKER).run({ page: "other-123456", path: entry }));
      expect(Exit.isFailure(unknown) && JSON.stringify(unknown.cause)).toContain(pinned.id);
      const solo = yield* Effect.exit(offer(SOLO).run({ page: pinned.id, path: entry }));
      expect(Exit.isFailure(solo) && JSON.stringify(solo.cause)).toContain("workspace");
      const unchanged = yield* pages.read(WS, pinned.id);
      expect(unchanged.offer).toBeUndefined();
      expect(unchanged.version).toBe(1);
    }).pipe(Effect.scoped),
  );
});
