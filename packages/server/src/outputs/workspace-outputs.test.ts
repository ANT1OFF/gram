import { describe, expect, it } from "@effect/vitest";
import type {
  GramUIMessageChunk,
  ServerEvent,
  ThreadId,
  WorkspaceId,
  WorkspaceOutput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { chunkOutput } from "./observed.ts";
import { WorkspaceOutputs } from "./workspace-outputs.ts";

const WORKSPACE = "w-files" as WorkspaceId;

/** A temp folder holding the data dir, a checkout and a folder outside it, real paths. */
const tempTree = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-outputs-")));
  const checkout = join(root, "repo");
  const outside = join(root, "elsewhere");
  const dataDir = join(root, "data");
  for (const dir of [checkout, outside, dataDir]) mkdirSync(dir, { recursive: true });
  return { root, checkout, outside, dataDir, done: () => rmSync(root, { recursive: true }) };
};

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

const write = (path: string, bytes: Buffer | string = PNG) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
};

const layerFor = (dataDir: string) =>
  WorkspaceOutputs.layer.pipe(
    Layer.provideMerge(makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir })),
  );

/** A worker of `workspaceId` on `checkout`, for feature `mail-trigger`; `null` a plain thread. */
const worker = (checkout: string, workspaceId: WorkspaceId | null = WORKSPACE) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* runtimes.create({
      projectRoot: checkout,
      checkout: { kind: "main", path: checkout },
      title: "Queue worker",
      ...(workspaceId === null
        ? {}
        : {
            workspaceId,
            spawnedBy: { threadId: "t-orchestrator" as ThreadId, feature: "mail-trigger" },
          }),
    });
  });

const listed = (query?: Parameters<WorkspaceOutputs["Service"]["list"]>[1]) =>
  Effect.gen(function* () {
    const outputs = yield* WorkspaceOutputs;
    return yield* outputs.list(WORKSPACE, query);
  });

const paths = (outputs: ReadonlyArray<WorkspaceOutput>) => outputs.map((output) => output.path);

describe("chunkOutput", () => {
  const parts: Record<string, Record<string, unknown> & { type: string }> = {
    shot: { type: "dynamic-tool", toolName: "mcp__playwright__screenshot", toolCallId: "shot" },
    read: { type: "tool-Read", toolCallId: "read" },
    write: { type: "tool-Write", toolCallId: "write", input: { file_path: "/r/docs/plan.md" } },
    code: { type: "tool-Write", toolCallId: "code", input: { file_path: "/r/src/a.ts" } },
    edit: { type: "tool-Edit", toolCallId: "edit", input: { file_path: "/r/docs/plan.md" } },
  };
  const of = (chunk: unknown) => chunkOutput(chunk as GramUIMessageChunk, (id) => parts[id]);

  it("takes a tool's stored image, a sent file and a Write of a document or media", () => {
    expect(
      of({
        type: "data-tool-image",
        data: { toolCallId: "shot", mediaType: "image/png", size: 1, path: "/d/a.png" },
      }),
    ).toEqual({ path: "/d/a.png", source: "toolImage" });
    expect(of({ type: "file", url: "file:///r/out/report.pdf", mediaType: "x" })).toEqual({
      path: "/r/out/report.pdf",
      source: "sent",
    });
    expect(of({ type: "tool-output-available", toolCallId: "write", output: "ok" })).toEqual({
      path: "/r/docs/plan.md",
      source: "written",
    });
  });

  it("leaves out a Read's image, an unstored image, code, edits and running output", () => {
    expect(
      of({
        type: "data-tool-image",
        data: { toolCallId: "read", mediaType: "image/png", size: 1, path: "/d/b.png" },
      }),
    ).toBeUndefined();
    expect(
      of({
        type: "data-tool-image",
        data: { toolCallId: "shot", mediaType: "image/png", size: 9 },
      }),
    ).toBeUndefined();
    expect(of({ type: "tool-output-available", toolCallId: "code", output: "" })).toBeUndefined();
    expect(of({ type: "tool-output-available", toolCallId: "edit", output: "" })).toBeUndefined();
    expect(
      of({ type: "tool-output-available", toolCallId: "write", output: "", preliminary: true }),
    ).toBeUndefined();
    expect(of({ type: "file", url: "https://example.invalid/a.png", mediaType: "x" })).toBe(
      undefined,
    );
  });
});

describe("WorkspaceOutputs", () => {
  it.effect("records evidence in the checkout with its thread, feature, kind and size", () => {
    const tree = tempTree();
    return Effect.gen(function* () {
      const outputs = yield* WorkspaceOutputs;
      const hub = yield* EventHub;
      const events: ServerEvent[] = [];
      yield* hub
        .internalEvents((event) => event.type === "outputs.changed")
        .pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      const thread = yield* worker(tree.checkout);
      const shot = join(tree.checkout, "docs/verification/after.png");
      const gif = join(tree.checkout, "docs/verification/flow.gif");
      write(shot);
      write(gif, Buffer.from("GIF89a...."));
      yield* outputs.record(thread.id, { path: shot, source: "evidence" });
      yield* outputs.record(thread.id, { path: "docs/verification/flow.gif", source: "evidence" });

      const page = yield* listed();
      expect(paths(page.outputs).toSorted()).toEqual([shot, gif].toSorted());
      const first = page.outputs.find((output) => output.path === shot)!;
      expect(first).toMatchObject({
        threadId: thread.id,
        threadTitle: "Queue worker",
        orchestrator: false,
        feature: "mail-trigger",
        kind: "screenshot",
        source: "evidence",
        mediaType: "image/png",
        size: PNG.length,
      });
      expect(page.outputs.find((output) => output.path === gif)?.kind).toBe("recording");
      expect(page.next).toBeUndefined();
      yield* waitFor(
        "outputs.changed",
        Effect.sync(() => events.length >= 2),
      );
      expect(events[0]).toEqual({ type: "outputs.changed", workspaceId: WORKSPACE });

      // Seen again unchanged, nobody is told; written again, they are.
      yield* outputs.record(thread.id, { path: shot, source: "evidence" });
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(events).toHaveLength(2);
      write(shot, Buffer.alloc(32));
      yield* outputs.record(thread.id, { path: shot, source: "evidence" });
      yield* waitFor(
        "the rewrite's outputs.changed",
        Effect.sync(() => events.length === 3),
      );
    }).pipe(
      Effect.provide(layerFor(tree.dataDir)),
      Effect.scoped,
      Effect.ensuring(Effect.sync(tree.done)),
    );
  });

  it.effect(
    "refuses links out of the checkout, credentials, missing files and others' paths",
    () => {
      const tree = tempTree();
      return Effect.gen(function* () {
        const outputs = yield* WorkspaceOutputs;
        const thread = yield* worker(tree.checkout);
        const secret = join(tree.outside, "secret.png");
        write(secret);
        // A link inside the checkout that leads out of it.
        symlinkSync(secret, join(tree.checkout, "linked.png"));
        mkdirSync(join(tree.checkout, "via"));
        symlinkSync(tree.outside, join(tree.checkout, "via/out"));
        // A file outside the thread's folders that it neither sent nor wrote.
        const stray = join(tree.outside, "stray.png");
        write(stray);
        // Another thread's stored tool image.
        const others = join(tree.dataDir, "attachments", "t-someone-else", "tool-1.png");
        write(others);
        write(join(tree.checkout, ".ssh/id_rsa.png"));
        // Linked folders whose real place is a credential folder or another thread's
        // attachments: `ln -s ~/.ssh /tmp/k; send_file /tmp/k/id_ed25519`, and the like.
        const home = join(tree.root, "home");
        write(join(home, ".ssh/id_ed25519"), "key");
        write(join(home, ".ssh/config"), "Host *");
        symlinkSync(join(home, ".ssh"), join(tree.outside, "k"));
        symlinkSync(join(tree.checkout, ".ssh"), join(tree.checkout, "keys"));
        symlinkSync(join(tree.dataDir, "attachments", "t-someone-else"), join(tree.outside, "att"));

        for (const output of [
          { path: join(tree.checkout, "linked.png"), source: "evidence" },
          { path: join(tree.checkout, "via/out/secret.png"), source: "evidence" },
          { path: stray, source: "evidence" },
          { path: stray, source: "toolImage" },
          { path: others, source: "sent" },
          { path: join(tree.checkout, "missing.png"), source: "evidence" },
          { path: join(tree.checkout, ".ssh/id_rsa.png"), source: "evidence" },
          { path: join(tree.outside, "k/id_ed25519"), source: "sent" },
          { path: join(tree.outside, "k/config"), source: "sent" },
          { path: join(tree.outside, "k/config"), source: "written" },
          { path: join(tree.checkout, "keys/id_rsa.png"), source: "evidence" },
          { path: join(tree.outside, "att/tool-1.png"), source: "sent" },
        ] as const) {
          yield* outputs.record(thread.id, output);
        }
        expect((yield* listed()).outputs).toEqual([]);

        // What it sent from outside its folders, and its own stored tool image, it may show.
        const own = join(tree.dataDir, "attachments", thread.id, "tool-2.png");
        write(own);
        yield* outputs.record(thread.id, { path: stray, source: "sent" });
        yield* outputs.record(thread.id, { path: own, source: "toolImage" });
        expect(paths((yield* listed()).outputs).toSorted()).toEqual([own, stray].toSorted());
      }).pipe(
        Effect.provide(layerFor(tree.dataDir)),
        Effect.scoped,
        Effect.ensuring(Effect.sync(tree.done)),
      );
    },
  );

  it.effect(
    "takes a file through a linked folder that leads somewhere ordinary, as macOS's /tmp does",
    () => {
      const tree = tempTree();
      return Effect.gen(function* () {
        const outputs = yield* WorkspaceOutputs;
        // `/tmp` → `/private/tmp`: a sent file named through the link is listed as named.
        const privateTmp = join(tree.root, "private-tmp");
        write(join(privateTmp, "report.pdf"), "%PDF-1.7");
        symlinkSync(privateTmp, join(tree.root, "tmp"));
        const sent = join(tree.root, "tmp", "report.pdf");
        // A checkout kept under a linked path, its evidence recorded by the real one.
        symlinkSync(tree.root, join(tree.root, "wt"));
        const linked = yield* worker(join(tree.root, "wt", "repo"));
        const shot = join(tree.checkout, "docs/verification/after.png");
        write(shot);
        // The file itself a link stays refused, even to an ordinary file.
        symlinkSync(join(privateTmp, "report.pdf"), join(privateTmp, "alias.pdf"));

        yield* outputs.record(linked.id, { path: sent, source: "sent" });
        yield* outputs.record(linked.id, { path: shot, source: "evidence" });
        yield* outputs.record(linked.id, { path: join(privateTmp, "alias.pdf"), source: "sent" });
        expect(paths((yield* listed()).outputs).toSorted()).toEqual([sent, shot].toSorted());
      }).pipe(
        Effect.provide(layerFor(tree.dataDir)),
        Effect.scoped,
        Effect.ensuring(Effect.sync(tree.done)),
      );
    },
  );

  it.effect("keeps one entry per file, pages newest first, filters by kind", () => {
    const tree = tempTree();
    return Effect.gen(function* () {
      const outputs = yield* WorkspaceOutputs;
      const thread = yield* worker(tree.checkout);
      const solo = yield* worker(tree.root, null);
      const names = ["a.png", "b.md", "c.png"].map((name) => join(tree.checkout, "out", name));
      for (const name of names) {
        write(name);
        yield* outputs.record(thread.id, { path: name, source: "written" });
      }
      // A thread outside the workspace isn't listed in it.
      write(join(tree.root, "solo.png"));
      yield* outputs.record(solo.id, { path: join(tree.root, "solo.png"), source: "written" });

      const all = yield* listed();
      expect(all.outputs).toHaveLength(3);
      const firstId = all.outputs.find((output) => output.path === names[0])!.id;
      // Written again, bigger: the same entry.
      write(names[0]!, Buffer.alloc(64));
      yield* outputs.record(thread.id, { path: names[0]!, source: "written" });
      const again = yield* listed();
      expect(again.outputs).toHaveLength(3);
      const rewritten = again.outputs.find((output) => output.path === names[0])!;
      expect(rewritten.id).toBe(firstId);
      expect(rewritten.size).toBe(64);

      const pages: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = yield* listed({ limit: 1, cursor });
        pages.push(...paths(page.outputs));
        cursor = page.next;
        if (cursor === undefined) break;
      }
      expect(pages).toEqual(paths(again.outputs));
      expect(new Set(pages).size).toBe(3);

      expect(paths((yield* listed({ kind: "document" })).outputs)).toEqual([names[1]]);
      const bad = yield* listed({ cursor: "nope" }).pipe(Effect.flip);
      expect(bad._tag).toBe("InvalidState");
    }).pipe(
      Effect.provide(layerFor(tree.dataDir)),
      Effect.scoped,
      Effect.ensuring(Effect.sync(tree.done)),
    );
  });

  it.effect("hears a file the agent sends, and forgets a thread's outputs as it closes", () => {
    const tree = tempTree();
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const sql = yield* SqlClient.SqlClient;
      const thread = yield* worker(tree.checkout);
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      const report = join(tree.checkout, "report.pdf");
      write(report, "%PDF-1.7");
      yield* runtimes.emitChunk(thread.id, {
        type: "file",
        url: pathToFileURL(report).href,
        mediaType: "application/pdf",
      });
      const page = yield* waitFor(
        "the sent file",
        listed().pipe(Effect.map((found) => (found.outputs.length === 1 ? found : undefined))),
      );
      expect(page.outputs[0]).toMatchObject({ path: report, kind: "document", source: "sent" });

      // In the same transaction as the thread: no row is left for a listener to clear.
      const rows = (id: ThreadId) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM thread_outputs WHERE thread_id = ${id}`.pipe(
          Effect.map((found) => found[0]?.n ?? 0),
          Effect.orDie,
        );
      expect(yield* rows(thread.id)).toBe(1);
      yield* store.closeThread(thread.id, Date.now());
      expect(yield* rows(thread.id)).toBe(0);

      const other = yield* worker(tree.checkout);
      const shot = join(tree.checkout, "shot.png");
      write(shot);
      const outputs = yield* WorkspaceOutputs;
      yield* outputs.record(other.id, { path: shot, source: "evidence" });
      expect(yield* rows(other.id)).toBe(1);
      yield* store.removeThread(other.id);
      expect(yield* rows(other.id)).toBe(0);
    }).pipe(
      Effect.provide(layerFor(tree.dataDir)),
      Effect.scoped,
      Effect.ensuring(Effect.sync(tree.done)),
    );
  });
});
