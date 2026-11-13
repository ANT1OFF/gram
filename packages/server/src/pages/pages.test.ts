import { describe, expect, it } from "@effect/vitest";
import {
  PAGE_FILES_MAX,
  PAGE_MANIFEST,
  type PageId,
  type ServerEvent,
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePages, pageTitle } from "./pages.ts";

const WS = "ws-pages" as WorkspaceId;
const AUTHOR = { threadId: "t-author" as ThreadId, title: "Draft a release board" };
const OTHER = { threadId: "t-other" as ThreadId, title: "Tidy the board" };

/** Pages under a fresh `<tmp>/state/pages`, a draft folder beside it, and the events published. */
const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-pages-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const root = join(dir, "state", "pages");
  mkdirSync(join(dir, "state"));
  const draft = join(dir, "worktree", "board");
  mkdirSync(draft, { recursive: true });
  writeFileSync(
    join(draft, "index.html"),
    '<!doctype html><title>Release &amp; radar</title><link rel="stylesheet" href="style.css"><p>v1</p>',
  );
  writeFileSync(join(draft, "style.css"), "p { color: teal }");
  mkdirSync(join(draft, "assets"));
  writeFileSync(join(draft, "assets", "app.js"), "console.log('v1')");
  const events: ServerEvent[] = [];
  const pages = makePages(root, (workspaceId) =>
    Effect.sync(() => void events.push({ type: "pages.changed", workspaceId })),
  );
  return { dir, root, draft, entry: join(draft, "index.html"), pages, events };
});

/** Every file of a version folder, by its path inside it. */
const filesOf = (folder: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(folder, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(folder, path), "utf8");
    }
  };
  walk("");
  return out;
};

describe("pinned pages", () => {
  it.effect("pins a copy that later edits in the worktree never change", () =>
    Effect.gen(function* () {
      const { draft, entry, pages, events } = yield* setup;
      const meta = yield* pages.pin({ workspaceId: WS, by: AUTHOR, entry });
      expect(meta).toMatchObject({
        title: "Release & radar",
        version: 1,
        entry: "index.html",
        authorThreadId: AUTHOR.threadId,
        authorTitle: AUTHOR.title,
      });
      expect(meta.offer).toBeUndefined();
      expect(events).toEqual([{ type: "pages.changed", workspaceId: WS }]);
      const shown = yield* pages.shown(WS, meta.id);
      const pinned = filesOf(shown.folder);
      expect(pinned).toEqual({
        "index.html": expect.stringContaining("<p>v1</p>"),
        "style.css": "p { color: teal }",
        "assets/app.js": "console.log('v1')",
        [PAGE_MANIFEST]: `${JSON.stringify({ entry: "index.html", reads: [] }, null, 2)}\n`,
      });

      // Everything a worktree can do to the draft afterwards: edit, add, delete, swap a file for a
      // link to elsewhere, and replace the whole folder.
      writeFileSync(entry, "<!doctype html><title>Changed</title><p>v2</p>");
      writeFileSync(join(draft, "new.js"), "steal()");
      rmSync(join(draft, "style.css"));
      rmSync(join(draft, "assets", "app.js"));
      symlinkSync("/etc/hostname", join(draft, "assets", "app.js"));
      rmSync(draft, { recursive: true, force: true });
      mkdirSync(draft);
      writeFileSync(entry, "<p>replaced</p>");

      const again = yield* pages.shown(WS, meta.id);
      expect(again.folder).toBe(shown.folder);
      expect(filesOf(again.folder)).toEqual(pinned);
      expect((yield* pages.read(WS, meta.id)).title).toBe("Release & radar");
    }).pipe(Effect.scoped),
  );

  it.effect("copies no dotfile, credential file, link or file a link leads to", () =>
    Effect.gen(function* () {
      const { dir, draft, entry, pages } = yield* setup;
      writeFileSync(join(draft, ".env"), "TOKEN=synthetic");
      mkdirSync(join(draft, ".git"));
      writeFileSync(join(draft, ".git", "config"), "[core]");
      writeFileSync(join(draft, "id_ed25519"), "synthetic key");
      writeFileSync(join(draft, "credentials.json"), "{}");
      const outside = join(dir, "outside.txt");
      writeFileSync(outside, "outside the folder");
      symlinkSync(outside, join(draft, "linked.txt"));
      mkdirSync(join(dir, "elsewhere"));
      writeFileSync(join(dir, "elsewhere", "secret.txt"), "elsewhere");
      symlinkSync(join(dir, "elsewhere"), join(draft, "linked-dir"));
      const meta = yield* pages.pin({ workspaceId: WS, by: AUTHOR, entry });
      const files = Object.keys(filesOf((yield* pages.shown(WS, meta.id)).folder));
      expect(files.toSorted()).toEqual(
        ["assets/app.js", "index.html", PAGE_MANIFEST, "style.css"].toSorted(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a folder past its limits or a manifest that declares a read", () =>
    Effect.gen(function* () {
      const { root, draft, entry, pages } = yield* setup;
      writeFileSync(
        join(draft, PAGE_MANIFEST),
        JSON.stringify({ entry: "index.html", reads: ["threads"] }),
      );
      const read = yield* Effect.exit(pages.pin({ workspaceId: WS, by: AUTHOR, entry }));
      expect(Exit.isFailure(read) && JSON.stringify(read.cause)).toContain("declare no reads");
      writeFileSync(join(draft, PAGE_MANIFEST), JSON.stringify({ entry: "other.html", reads: [] }));
      const other = yield* Effect.exit(pages.pin({ workspaceId: WS, by: AUTHOR, entry }));
      expect(Exit.isFailure(other) && JSON.stringify(other.cause)).toContain("index.html");
      writeFileSync(join(draft, PAGE_MANIFEST), JSON.stringify({ entry: "index.html", reads: [] }));
      for (let n = 0; n < PAGE_FILES_MAX; n++) writeFileSync(join(draft, `f${n}.txt`), "x");
      const many = yield* Effect.exit(pages.pin({ workspaceId: WS, by: AUTHOR, entry }));
      expect(Exit.isFailure(many) && JSON.stringify(many.cause)).toContain(
        `more than ${PAGE_FILES_MAX} files`,
      );
      // Nothing of a refused pin is left behind.
      expect(yield* pages.list(WS)).toEqual([]);
      expect(readdirSync(join(root, WS))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an offer beside the shown version until the user shows it", () =>
    Effect.gen(function* () {
      const { draft, entry, pages, events } = yield* setup;
      const meta = yield* pages.pin({ workspaceId: WS, by: AUTHOR, entry });
      const before = filesOf((yield* pages.shown(WS, meta.id)).folder);
      writeFileSync(entry, "<!doctype html><title>Radar two</title><p>v2</p>");
      const offered = yield* pages.offer({ workspaceId: WS, id: meta.id, by: OTHER, entry });
      expect(offered.version).toBe(1);
      expect(offered.offer).toMatchObject({
        version: 2,
        title: "Radar two",
        threadId: OTHER.threadId,
        threadTitle: OTHER.title,
      });
      // The page still shows what the user pinned, byte for byte.
      const shown = yield* pages.shown(WS, meta.id);
      expect(shown.version).toBe(1);
      expect(filesOf(shown.folder)).toEqual(before);
      // An offer made while the worktree changes again is the copy taken when it was offered.
      writeFileSync(entry, "<p>v3 in the worktree</p>");
      const stale = yield* Effect.exit(pages.showOffer(WS, meta.id, 3));
      expect(Exit.isFailure(stale)).toBe(true);
      const now = yield* pages.showOffer(WS, meta.id, 2);
      expect(now).toMatchObject({ version: 2, title: "Radar two" });
      expect(now.offer).toBeUndefined();
      const after = yield* pages.shown(WS, meta.id);
      expect(filesOf(after.folder)["index.html"]).toBe(
        "<!doctype html><title>Radar two</title><p>v2</p>",
      );
      expect(readdirSync(join(draft, ".."))).toContain("board");
      expect(events.length).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("unpins, and refuses ids that aren't a page's", () =>
    Effect.gen(function* () {
      const { entry, pages } = yield* setup;
      const meta = yield* pages.pin({ workspaceId: WS, by: AUTHOR, entry });
      yield* pages.unpin(WS, meta.id);
      expect(yield* pages.list(WS)).toEqual([]);
      for (const id of ["../x", "a/b", "", "UPPER", meta.id]) {
        const exit = yield* Effect.exit(pages.shown(WS, id as PageId));
        expect(Exit.isFailure(exit), id).toBe(true);
      }
      const badWorkspace = yield* Effect.exit(pages.list("../etc" as WorkspaceId));
      expect(Exit.isFailure(badWorkspace)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("pageTitle", () => {
  it("reads the entry's title as plain text, or falls back to its file name", () => {
    expect(pageTitle("<title>  A\n &lt;b&gt; &#x263A; </title>", "x.html")).toBe("A <b> ☺");
    expect(pageTitle("<p>no title</p>", "release-board.html")).toBe("release-board");
    expect(pageTitle("<title>a‮b</title>", "x.html")).toBe("a b");
    expect(pageTitle(`<title>${"w".repeat(300)}</title>`, "x.html")).toHaveLength(120);
  });
});
