import { describe, expect, it } from "@effect/vitest";
import { FsError, InvalidState, NotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPlatformTest } from "../../git/platform.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { CheckoutService, TurnHooks } from "../../runtime/hooks.ts";
import { CheckoutsOnDisk, makeRuntimeTestLayer, waitFor } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { fsHandlers } from "./fs.ts";
import { threadHandlers } from "./threads.ts";

const TestLayer = Layer.merge(
  makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutsOnDisk),
  gitPlatformTest(),
);

const tempTree = Effect.gen(function* () {
  const root = mkdtempSync(join(tmpdir(), "gram-picker-"));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true })));
  mkdirSync(join(root, "example-identity-apps", ".git"), { recursive: true });
  mkdirSync(join(root, "sys_other"));
  writeFileSync(join(root, "notes.txt"), "hi");
  return root;
});

describe("thread.create folder errors", () => {
  it.effect("reports a missing folder as NotFound and a file as InvalidState", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const handlers = yield* threadHandlers;
      const create = (projectRoot: string) =>
        handlers["thread.create"]({ projectRoot, checkout: { kind: "current" } }).pipe(Effect.flip);

      const missing = yield* create(join(root, "code", "example-identity-apps"));
      expect(missing).toEqual(
        new NotFound({
          entity: "project",
          id: join(root, "code", "example-identity-apps"),
          message: `Folder not found: ${join(root, "code", "example-identity-apps")}`,
        }),
      );

      const file = yield* create(join(root, "notes.txt"));
      expect(file).toBeInstanceOf(InvalidState);
      expect(file).toMatchObject({ message: `Not a folder: ${join(root, "notes.txt")}` });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("trims whitespace, keeps a trailing period, and stores nothing", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const handlers = yield* threadHandlers;
      const store = yield* ThreadStore;
      const typo = join(root, "example-identity-apps.");

      const error = yield* handlers["thread.create"]({
        projectRoot: `  ${typo}\n`,
        checkout: { kind: "current" },
      }).pipe(Effect.flip);
      expect(error).toEqual(
        new NotFound({ entity: "project", id: typo, message: `Folder not found: ${typo}` }),
      );
      expect(yield* store.listThreads).toEqual([]);
      expect(yield* store.listProjects).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("prepare checks the folder for every checkout kind", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const checkouts = yield* CheckoutService;
      const missing = join(root, "gone");

      const current = yield* checkouts.prepare({ kind: "current" }, [], missing).pipe(Effect.flip);
      expect(current).toEqual(
        new NotFound({ entity: "project", id: missing, message: `Folder not found: ${missing}` }),
      );
      const existing = yield* checkouts
        .prepare({ kind: "existingWorktree", path: missing }, [], root)
        .pipe(Effect.flip);
      expect(existing).toEqual(
        new NotFound({ entity: "project", id: missing, message: `Folder not found: ${missing}` }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("a thread whose folder was deleted", () => {
  it.effect("refuses a send with the folder to restore, and shows no activity for it", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const handlers = yield* threadHandlers;
      const runtimes = yield* ThreadRuntimes;
      const folder = join(root, "sys_other");
      const thread = yield* handlers["thread.create"]({
        projectRoot: folder,
        checkout: { kind: "current" },
      });

      rmSync(folder, { recursive: true });
      // An idle thread with an activity line reads as working; the git state says it's gone.
      const summary = (yield* runtimes.snapshot).find((s) => s.thread.id === thread.id);
      expect(summary?.activity).toBeUndefined();
      const refused = yield* runtimes.send(thread.id, { text: "hi" }).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "InvalidState",
        message: `This thread's folder no longer exists: ${folder}`,
        folderMissing: { path: folder },
      });
      // A session it had opened is stopped, so nothing runs on in the deleted folder.
      yield* waitFor(
        "the session stopped",
        runtimes.status(thread.id).pipe(Effect.map((status) => status === "cold")),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("fs.tree folder browsing", () => {
  it.effect("lists folders and completes a typed prefix", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const handlers = yield* fsHandlers;

      const listing = yield* handlers["fs.tree"]({ root });
      expect(listing.root).toBe(root);
      expect(listing.entries.map((e) => e.name)).toEqual(["example-identity-apps", "sys_other"]);
      expect(listing.entries.every((e) => e.kind === "dir")).toBe(true);

      const completed = yield* handlers["fs.tree"]({ root, path: join(root, "example-id") });
      expect(completed.entries.map((e) => e.name)).toEqual(["example-identity-apps"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with a friendly FsError for a missing folder", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const handlers = yield* fsHandlers;
      const missing = join(root, "code");
      const error = yield* handlers["fs.tree"]({ root: missing }).pipe(Effect.flip);
      expect(error).toEqual(
        new FsError({ path: missing, message: `Folder not found: ${missing}` }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
