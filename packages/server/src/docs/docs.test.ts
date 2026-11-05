import { describe, expect, it } from "@effect/vitest";
import {
  DOC_MAX_BYTES,
  DocId,
  type ServerEvent,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-docs-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const root = join(dir, "state", "docs");
  const events: ServerEvent[] = [];
  const docs = makeDocs(root, (workspaceId) =>
    Effect.sync(() => void events.push({ type: "docs.changed", workspaceId })),
  );
  return { dir, root, docs, events };
});

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
      expect(readdirSync(folder).toSorted()).toEqual([`${meta.id}.json`, `${meta.id}.md`]);
      expect(readFileSync(join(folder, `${meta.id}.md`), "utf8")).toBe(REPORT);
      expect(JSON.parse(readFileSync(join(folder, `${meta.id}.json`), "utf8"))).toEqual(meta);
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
        expect(statSync(join(root, WS, `${meta.id}.md`)).mode & 0o777).toBe(0o600);
        expect(statSync(join(root, WS, `${meta.id}.json`)).mode & 0o777).toBe(0o600);
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
        expect(error.message).toContain("is a link or not a folder");
        expect(readdirSync(outside)).toEqual([]);
        expect((yield* Effect.flip(docs.list(WS))).message).toContain("is a link");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "refuses to read a doc file that is a link, and a save replaces the link, not its target",
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
        const file = join(root, WS, `${meta.id}.md`);
        rmSync(file);
        symlinkSync(secret, file);
        const error = yield* Effect.flip(docs.read(WS, meta.id));
        expect(error.message).toContain("isn't a plain file");
        yield* docs.save(WS, meta.id, "replaced", 1);
        expect(readFileSync(secret, "utf8")).toBe("not a doc");
        expect((yield* docs.read(WS, meta.id)).content).toBe("replaced");
      }).pipe(Effect.scoped),
  );

  it.effect("ignores a metadata file that claims another doc or workspace", () =>
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
        join(folder, "forged.json"),
        JSON.stringify({ ...meta, id: "forged", workspaceId: OTHER_WS }),
      );
      writeFileSync(join(folder, "forged.md"), "forged");
      writeFileSync(join(folder, "broken.json"), "{");
      writeFileSync(join(folder, "Not An Id.json"), JSON.stringify(meta));
      expect((yield* docs.list(WS)).map((doc) => doc.id)).toEqual([meta.id]);
      const forged = yield* Effect.flip(docs.read(WS, "forged" as DocId));
      expect(forged.message).toContain("details don't read");
    }).pipe(Effect.scoped),
  );
});
