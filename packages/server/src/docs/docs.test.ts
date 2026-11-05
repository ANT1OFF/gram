import { describe, expect, it } from "@effect/vitest";
import {
  DOC_MAX_BYTES,
  DOC_TITLE_MAX,
  DocId,
  type ServerEvent,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DocFileHooks } from "./doc-files.ts";
import { makeDocs, newDocId, type DocAuthor } from "./docs.ts";

const WS = "ws-docs" as WorkspaceId;
const OTHER_WS = "ws-other" as WorkspaceId;
const worker = (n: number): DocAuthor => ({
  threadId: `t-worker-${n}` as ThreadId,
  title: `Worker ${n}`,
  orchestrator: false,
});
const ORCHESTRATOR: DocAuthor = {
  threadId: "t-orchestrator" as ThreadId,
  title: "Orchestrator",
  orchestrator: true,
};

/** Docs under a fresh `<tmp>/state/docs`, with the events they published. */
const setupWith = (hooks?: DocFileHooks) =>
  Effect.gen(function* () {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-docs-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const root = join(dir, "state", "docs");
    const events: ServerEvent[] = [];
    const docs = makeDocs(
      root,
      (workspaceId) => Effect.sync(() => void events.push({ type: "docs.changed", workspaceId })),
      hooks,
    );
    return { dir, root, docs, events };
  });
const setup = setupWith();

/** A record as the store writes it: its metadata line, then its Markdown. */
const record = (meta: object, content: string) => `${JSON.stringify(meta)}\n${content}`;

const REPORT = `# Harness features for gram: gap analysis

Gram covers **most** of the [harness](https://example.invalid) surface.

| Feature | State |
| --- | --- |
| Docs | New |

\`\`\`ts
const x = 1;
\`\`\`
`;

describe("docs", () => {
  it.effect("publishes a doc as Markdown and metadata in the workspace's folder", () =>
    Effect.gen(function* () {
      const { root, docs, events } = yield* setup;
      yield* TestClock.setTime(1_700_000_000_000);
      const { meta, action } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Harness features for gram:   gap analysis",
        content: REPORT,
      });
      expect(action).toBe("published");
      expect(meta).toEqual({
        id: expect.stringMatching(/^harness-features-for-gram-gap-analysis-[0-9a-f]{6}$/),
        workspaceId: WS,
        title: "Harness features for gram: gap analysis",
        authorThreadId: "t-worker-1",
        authorTitle: "Worker 1",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        updatedBy: "agent",
        revision: 1,
        bytes: Buffer.byteLength(REPORT),
        excerpt: "Gram covers most of the harness surface. Feature · State Docs · New",
      });
      const folder = join(root, WS);
      // One record: its metadata line, then the Markdown as published.
      expect(readdirSync(folder)).toEqual([`${meta.id}.doc`]);
      expect(readFileSync(join(folder, `${meta.id}.doc`), "utf8")).toBe(record(meta, REPORT));
      expect(events).toEqual([{ type: "docs.changed", workspaceId: WS }]);
      expect(yield* docs.read(WS, meta.id)).toEqual({ ...meta, content: REPORT });
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "keeps the folder and files private to the user",
    () =>
      Effect.gen(function* () {
        const { root, docs } = yield* setup;
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "Steps.",
        });
        expect(statSync(join(root, WS)).mode & 0o777).toBe(0o700);
        expect(statSync(root).mode & 0o777).toBe(0o700);
        expect(statSync(join(root, WS, `${meta.id}.doc`)).mode & 0o777).toBe(0o600);
      }).pipe(Effect.scoped),
  );

  it.effect("lists a workspace's docs newest first, and none for a workspace without any", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      expect(yield* docs.list(WS)).toEqual([]);
      const first = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "First",
        content: "a",
      });
      yield* TestClock.adjust("1 minute");
      const second = yield* docs.publish({
        workspaceId: WS,
        author: worker(2),
        title: "Second",
        content: "b",
      });
      yield* docs.publish({
        workspaceId: OTHER_WS,
        author: worker(3),
        title: "Elsewhere",
        content: "",
      });
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([second.meta.id, first.meta.id]);
    }).pipe(Effect.scoped),
  );

  it.effect("updates over the current revision, keeping when and by whom it was created", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Plan",
        content: "v1",
      });
      yield* TestClock.adjust("2 minutes");
      const updated = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id: meta.id,
        revision: 1,
        content: "v2",
      });
      expect(updated.action).toBe("updated");
      expect(updated.meta).toMatchObject({
        id: meta.id,
        title: "Plan",
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt + 120_000,
        revision: 2,
        authorThreadId: "t-worker-1",
      });
      expect((yield* docs.read(WS, meta.id)).content).toBe("v2");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an update without the current revision, naming the user's edit", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Plan",
        content: "agent text",
      });
      const missing = yield* Effect.flip(
        docs.publish({ workspaceId: WS, author: worker(1), id: meta.id, content: "x" }),
      );
      expect(missing.message).toContain("needs `revision`");
      const saved = yield* docs.save(WS, meta.id, "the user's edit", 1);
      expect(saved).toMatchObject({ revision: 2, updatedBy: "user" });
      const stale = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(1),
          id: meta.id,
          revision: 1,
          content: "x",
        }),
      );
      expect(stale._tag).toBe("InvalidState");
      expect(stale.message).toContain("moved on to revision 2, which the user saved");
      expect((yield* docs.read(WS, meta.id)).content).toBe("the user's edit");
    }).pipe(Effect.scoped),
  );

  it.effect("lets only the author or the orchestrator update a doc", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Mine",
        content: "v1",
      });
      const other = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(2),
          id: meta.id,
          revision: 1,
          content: "x",
        }),
      );
      expect(other.message).toContain("was published by Worker 1");
      const byOrchestrator = yield* docs.publish({
        workspaceId: WS,
        author: ORCHESTRATOR,
        id: meta.id,
        revision: 1,
        content: "relayed",
      });
      expect(byOrchestrator.meta).toMatchObject({ revision: 2, authorThreadId: "t-worker-1" });
      // Another workspace's thread names a doc that isn't in its workspace.
      const elsewhere = yield* Effect.flip(
        docs.publish({
          workspaceId: OTHER_WS,
          author: ORCHESTRATOR,
          id: meta.id,
          revision: 2,
          content: "x",
        }),
      );
      expect(elsewhere.message).toContain(`No doc ${meta.id} in this workspace`);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a user save over a revision that moved on", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Plan",
        content: "v1",
      });
      yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id: meta.id,
        revision: 1,
        content: "v2",
      });
      const error = yield* Effect.flip(docs.save(WS, meta.id, "mine", 1));
      expect(error.message).toContain("changed since you opened it");
      expect((yield* docs.read(WS, meta.id)).content).toBe("v2");
    }).pipe(Effect.scoped),
  );

  it.effect("censors secrets an agent publishes and caps a doc's size", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Setup",
        // Synthetic, and built here so no file holds a token-shaped string.
        content: `Run gh auth ${["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_")} first.`,
      });
      expect((yield* docs.read(WS, meta.id)).content).toBe("Run gh auth [redacted] first.");
      const big = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Big",
          content: "x".repeat(DOC_MAX_BYTES + 1),
        }),
      );
      expect(big.message).toContain("at most 256 KB");
      const untitled = yield* Effect.flip(
        docs.publish({ workspaceId: WS, author: worker(1), title: "   ", content: "x" }),
      );
      expect(untitled.message).toBe("A new doc needs a title");
    }).pipe(Effect.scoped),
  );
});

describe("doc paths", () => {
  it("accepts only slug ids, so no id can name a path", () => {
    const decode = Schema.decodeUnknownOption(DocId);
    for (const ok of ["plan", "gap-analysis-3f9a2c", "a1"]) expect(decode(ok)._tag).toBe("Some");
    for (const bad of [
      "",
      "../escape",
      "a/b",
      "a\\b",
      "plan.md",
      ".hidden",
      "-lead",
      "trail-",
      "Upper",
      "a b",
      "x".repeat(65),
    ]) {
      expect(decode(bad)._tag).toBe("None");
    }
    expect(newDocId("../../etc/passwd")).toMatch(/^etc-passwd-[0-9a-f]{6}$/);
    expect(newDocId("Ünïcödé ✨")).toMatch(/^unicode-[0-9a-f]{6}$/);
    expect(newDocId("✨✨")).toMatch(/^doc-[0-9a-f]{6}$/);
  });

  it.effect("refuses an id or workspace that would leave the docs folder", () =>
    Effect.gen(function* () {
      const { dir, docs } = yield* setup;
      const badId = yield* Effect.flip(docs.read(WS, "../../outside" as DocId));
      expect(badId.message).toBe("../../outside isn't a doc id");
      const badUpdate = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(1),
          id: "../x" as DocId,
          revision: 1,
          content: "",
        }),
      );
      expect(badUpdate._tag).toBe("InvalidState");
      for (const workspace of ["../escape", "a/b", "..", ""]) {
        const error = yield* Effect.flip(
          docs.publish({
            workspaceId: workspace as WorkspaceId,
            author: worker(1),
            title: "Escape",
            content: "x",
          }),
        );
        expect(error.message).toBe("That isn't a workspace docs can be kept for");
      }
      expect(existsSync(join(dir, "escape"))).toBe(false);
      expect(existsSync(join(dir, "state", "escape"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "refuses a workspace folder that is a link, writing nothing through it",
    () =>
      Effect.gen(function* () {
        const { dir, root, docs } = yield* setup;
        const outside = join(dir, "outside");
        mkdirSync(outside);
        mkdirSync(root, { recursive: true });
        symlinkSync(outside, join(root, WS));
        const error = yield* Effect.flip(
          docs.publish({ workspaceId: WS, author: worker(1), title: "Plan", content: "x" }),
        );
        expect(error.message).toContain("is a link, not a folder, or not yours");
        expect(readdirSync(outside)).toEqual([]);
        expect((yield* Effect.flip(docs.list(WS))).message).toContain("is a link");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "refuses a doc file that is a link, reading and writing nothing through it",
    () =>
      Effect.gen(function* () {
        const { dir, root, docs } = yield* setup;
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "mine",
        });
        const secret = join(dir, "secret.txt");
        writeFileSync(secret, "not a doc");
        const file = join(root, WS, `${meta.id}.doc`);
        rmSync(file);
        symlinkSync(secret, file);
        const error = yield* Effect.flip(docs.read(WS, meta.id));
        expect(error.message).toContain("isn't a plain file");
        const saved = yield* Effect.flip(docs.save(WS, meta.id, "replaced", 1));
        expect(saved._tag).toBe("InvalidState");
        expect(readFileSync(secret, "utf8")).toBe("not a doc");
      }).pipe(Effect.scoped),
  );

  it.effect("leaves out a record that claims another doc or workspace, or doesn't read", () =>
    Effect.gen(function* () {
      const { root, docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Real",
        content: "x",
      });
      const folder = join(root, WS);
      writeFileSync(
        join(folder, "forged.doc"),
        record({ ...meta, id: "forged", workspaceId: OTHER_WS }, "x"),
      );
      writeFileSync(join(folder, "broken.doc"), "{\nx");
      writeFileSync(join(folder, "Not An Id.doc"), record(meta, "x"));
      // Text that doesn't match the length its metadata says is a torn or tampered record.
      writeFileSync(join(folder, "torn.doc"), record({ ...meta, id: "torn" }, "xx"));
      // The list reads only each record's metadata line, so a torn one is listed; it won't open.
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([meta.id, "torn"]);
      const forged = yield* Effect.flip(docs.read(WS, "forged" as DocId));
      expect(forged.message).toContain("details don't read");
      expect((yield* Effect.flip(docs.read(WS, "torn" as DocId))).message).toContain(
        "details don't read",
      );
    }).pipe(Effect.scoped),
  );
});

/** Swaps the workspace folder for a link to `outside`, as a racing local writer would. */
const swap = (root: string, outside: string) => {
  const folder = join(root, WS);
  renameSync(folder, `${folder}.real`);
  symlinkSync(outside, folder);
};
const swapBack = (root: string) => {
  const folder = join(root, WS);
  rmSync(folder);
  renameSync(`${folder}.real`, folder);
};

// The independent review of #197 (P1–P5): a test for each finding.
describe("doc review findings", () => {
  it.effect("P1: a failed commit (a full disk at the rename) leaves the last saved doc whole", () =>
    Effect.gen(function* () {
      let full = false;
      const { root, docs } = yield* setupWith({
        rename: async (from, to) => {
          if (full) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
          await rename(from, to);
        },
      });
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Plan",
        content: "rev 1",
      });
      full = true;
      const failed = yield* Effect.flip(
        docs.publish({
          workspaceId: WS,
          author: worker(1),
          id: meta.id,
          revision: 1,
          content: "rev 2",
        }),
      );
      expect(failed._tag).toBe("FsError");
      expect(failed.message).toContain("ENOSPC");
      expect(failed.message).not.toContain(root);
      const read = yield* docs.read(WS, meta.id);
      expect([read.revision, read.content]).toEqual([1, "rev 1"]);
      expect((yield* docs.list(WS)).map((doc) => doc.revision)).toEqual([1]);
      // No temp file is left behind.
      expect(readdirSync(join(root, WS))).toEqual([`${meta.id}.doc`]);
      full = false;
      const saved = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        id: meta.id,
        revision: 1,
        content: "rev 2",
      });
      expect(saved.meta.revision).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "P1 (re-review): a save cancelled mid-commit keeps the lock until its write settles",
    () =>
      Effect.gen(function* () {
        // The first gated rename waits until released, as a slow disk would.
        let gated = false;
        const inRename = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const { docs } = yield* setupWith({
          rename: async (from, to) => {
            if (gated) {
              gated = false;
              inRename.resolve();
              await released.promise;
            }
            await rename(from, to);
          },
        });
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "rev 1",
        });
        gated = true;
        const saveA = yield* Effect.forkScoped(docs.save(WS, meta.id, "A's edit", 1));
        yield* Effect.promise(() => inRename.promise);
        // Cancel A while its rename waits, then save B over the same revision.
        const cancelA = yield* Effect.forkScoped(Fiber.interrupt(saveA));
        const saveB = yield* Effect.forkScoped(Effect.exit(docs.save(WS, meta.id, "B's edit", 1)));
        yield* Effect.sleep("50 millis");
        released.resolve();
        yield* Fiber.join(cancelA);
        const b = yield* Fiber.join(saveB);
        const final = yield* docs.read(WS, meta.id);
        // A's write landed while it held the lock, so B, over revision 1, is refused, not lost.
        expect(b._tag).toBe("Failure");
        expect([final.revision, final.content]).toEqual([2, "A's edit"]);
      }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("P1: an unlocked read always sees one revision's text with that revision", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Plan",
        content: "rev 1",
      });
      const updates = Effect.forEach(
        Array.from({ length: 30 }, (_, i) => i + 1),
        (revision) =>
          docs.publish({
            workspaceId: WS,
            author: worker(1),
            id: meta.id,
            revision,
            content: `rev ${revision + 1}`,
          }),
      );
      const reads = Effect.forEach(Array.from({ length: 60 }), () => docs.read(WS, meta.id), {
        concurrency: 4,
      });
      const [, seen] = yield* Effect.all([updates, reads], { concurrency: 2 });
      for (const doc of seen) expect(doc.content).toBe(`rev ${doc.revision}`);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "P2: refuses a docs root that is a link, writing nothing through it",
    () =>
      Effect.gen(function* () {
        const { dir, root, docs } = yield* setup;
        const outside = join(dir, "outside");
        mkdirSync(outside);
        mkdirSync(join(root, ".."), { recursive: true });
        symlinkSync(outside, root);
        const error = yield* Effect.flip(
          docs.publish({ workspaceId: WS, author: worker(1), title: "Plan", content: "secret" }),
        );
        expect(error.message).toContain("is a link, not a folder, or not yours");
        // `mkdir` may have made the empty workspace folder before the refusal; no doc is written.
        expect(readdirSync(outside).flatMap((name) => readdirSync(join(outside, name)))).toEqual(
          [],
        );
        expect((yield* Effect.flip(docs.list(WS))).message).toContain("is a link");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "P2: a read whose folder is swapped for a link after the check returns nothing from outside",
    () =>
      Effect.gen(function* () {
        let race: ((path: string) => Promise<void>) | undefined;
        let after: ((path: string) => Promise<void>) | undefined;
        const { dir, root, docs } = yield* setupWith({
          beforeOpen: async (path) => race?.(path),
          afterOpen: async (path) => after?.(path),
        });
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "mine",
        });
        // Outside, a record of the same name holding text that must never be served.
        const outside = join(dir, "outside");
        mkdirSync(outside);
        writeFileSync(
          join(outside, `${meta.id}.doc`),
          record(meta, "SECRET").replace('"bytes":4', '"bytes":6'),
        );

        // Swapped and left: the folder is no longer the pinned one.
        race = async () => {
          race = undefined;
          swap(root, outside);
        };
        const left = yield* Effect.flip(docs.read(WS, meta.id));
        expect(left.message).toContain("changed during the operation");
        swapBack(root);

        // Swapped, then put back once the outside file is open: the file at the path is not it.
        let opened = 0;
        race = async () => {
          race = undefined;
          swap(root, outside);
        };
        after = async () => {
          after = undefined;
          opened += 1;
          swapBack(root);
        };
        // The outside file's read fails its check and is dropped; the read tried again is ours.
        expect((yield* docs.read(WS, meta.id)).content).toBe("mine");
        expect(opened).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "P2: a write whose folder is swapped for a link after the check puts no text outside",
    () =>
      Effect.gen(function* () {
        let race: ((path: string) => Promise<void>) | undefined;
        const { dir, root, docs } = yield* setupWith({ beforeOpen: async (path) => race?.(path) });
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "mine",
        });
        const outside = join(dir, "outside");
        mkdirSync(outside);
        race = async (path) => {
          if (!path.includes(".tmp-")) return;
          race = undefined;
          swap(root, outside);
        };
        const error = yield* Effect.flip(docs.save(WS, meta.id, "SECRET", 1));
        expect(error.message).toContain("changed during the operation");
        for (const name of readdirSync(outside)) {
          expect(readFileSync(join(outside, name), "utf8")).not.toContain("SECRET");
        }
        swapBack(root);
        expect((yield* docs.read(WS, meta.id)).content).toBe("mine");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "P2 (re-review): a folder swapped just before the rename is caught before it, touching nothing outside",
    () =>
      Effect.gen(function* () {
        let race: ((temp: string) => Promise<void>) | undefined;
        const { dir, root, docs } = yield* setupWith({
          beforeRename: async (temp) => race?.(temp),
        });
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: "Plan",
          content: "mine",
        });
        // Outside, a file of the doc's name the rename would replace, and the temp linked in too.
        const outside = join(dir, "outside");
        mkdirSync(outside);
        const victim = join(outside, `${meta.id}.doc`);
        writeFileSync(victim, "outside's own");
        race = async (temp) => {
          race = undefined;
          linkSync(temp, join(outside, basename(temp)));
          swap(root, outside);
        };
        const error = yield* Effect.flip(docs.save(WS, meta.id, "SECRET", 1));
        expect(error.message).toContain("changed during the operation");
        expect(readFileSync(victim, "utf8")).toBe("outside's own");
        swapBack(root);
        expect((yield* docs.read(WS, meta.id)).content).toBe("mine");
      }).pipe(Effect.scoped),
  );

  it.effect("P2: an oversized author title is bounded, so the doc stays listed and readable", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      const author = { ...worker(1), title: "w".repeat(17_000) };
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author,
        title: "t".repeat(17_000),
        content: "x",
      });
      expect(meta.authorTitle.length).toBeLessThanOrEqual(DOC_TITLE_MAX);
      expect(meta.title.length).toBeLessThanOrEqual(DOC_TITLE_MAX);
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([meta.id]);
      expect((yield* docs.read(WS, meta.id)).content).toBe("x");
    }).pipe(Effect.scoped),
  );

  it.effect("P3: text that reads like a verdict publishes and reads back as text", () =>
    Effect.gen(function* () {
      const { docs } = yield* setup;
      for (const content of ["not-plain", "too-big", "Missing", "NotPlain"]) {
        const { meta } = yield* docs.publish({
          workspaceId: WS,
          author: worker(1),
          title: content,
          content,
        });
        expect((yield* docs.read(WS, meta.id)).content).toBe(content);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("P5: metadata with an impossible time is left out, not thrown on", () =>
    Effect.gen(function* () {
      const { root, docs } = yield* setup;
      const { meta } = yield* docs.publish({
        workspaceId: WS,
        author: worker(1),
        title: "Real",
        content: "x",
      });
      writeFileSync(
        join(root, WS, "far-future.doc"),
        record({ ...meta, id: "far-future", updatedAt: 1e100 }, "x"),
      );
      writeFileSync(
        join(root, WS, "negative.doc"),
        record({ ...meta, id: "negative", createdAt: -1 }, "x"),
      );
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([meta.id]);
      const error = yield* Effect.flip(docs.read(WS, "far-future" as DocId));
      expect(error.message).toContain("details don't read");
    }).pipe(Effect.scoped),
  );
});
