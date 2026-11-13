import { describe, expect, it } from "@effect/vitest";
import {
  ThreadNotFound,
  type PageId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePages } from "../pages/pages.ts";
import { VIEWER_RPCS } from "../rpc/actor-guard.ts";
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
      const unchanged = yield* pages.read(WS, pinned.id as PageId);
      expect(unchanged.offer).toBeUndefined();
      expect(unchanged.version).toBe(1);
    }).pipe(Effect.scoped),
  );
});

/** Every source file of the server, by its path under `src`, tests left out. */
const serverSources = (): Array<{ path: string; text: string }> => {
  const root = join(import.meta.dirname, "..");
  const out: Array<{ path: string; text: string }> = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ path, text: readFileSync(join(root, path), "utf8") });
      }
    }
  };
  walk("");
  return out;
};

describe("no agent pins a page", () => {
  it("only the user's RPC handlers reach the pages store; the one tool offers", () => {
    // Who takes the store, and what each calls on it.
    const users = serverSources().filter(
      ({ text, path }) => path !== "pages/pages.ts" && /yield\* Pages\b/.test(text),
    );
    expect(users.map(({ path }) => path).toSorted()).toEqual([
      "app-tools/page-tools.ts",
      "rpc/handlers/pages.ts",
    ]);
    const tool = users.find(({ path }) => path === "app-tools/page-tools.ts")!.text;
    expect(tool).toContain('Pick<PagesShape, "list" | "offer">');
    expect(tool).not.toMatch(/\.(pin|showOffer|unpin|shown)\(/);
    // The one app tool that imports the store is this one.
    const tools = serverSources().filter(
      ({ path, text }) => path.startsWith("app-tools/") && text.includes('"../pages/pages.ts"'),
    );
    expect(tools.map(({ path }) => path)).toEqual(["app-tools/page-tools.ts"]);
    // A viewer of an embedding deployment can't pin, show, unpin or open one either.
    for (const rpc of ["pages.pin", "pages.showOffer", "pages.unpin", "pages.open", "pages.list"]) {
      expect(VIEWER_RPCS.has(rpc), rpc).toBe(false);
    }
  });

  it("is bound for workers and solo threads, never the orchestrator's prompt budget", () => {
    expect(offerPageTool({} as never, {} as never).audience).toEqual(["plain", "worker"]);
  });
});
