import { describe, expect, it } from "@effect/vitest";
import { type GramUIMessage, HostId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfigShape } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "../../runtime/test-harness.ts";
import { CheckoutService, TurnHooks } from "../../runtime/hooks.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { fsHandlers } from "./fs.ts";

const layerWith = (config: ServerConfigShape) =>
  Layer.merge(
    makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, config),
    gitPlatformTest(),
  );

/**
 * A thread whose folder is on this disk, with a file outside it that its messages name: a page
 * and a Markdown note, both written by a finished Write and named in the text, and an image.
 */
const vouchedThread = (options: { readonly dreamHost?: HostId } = {}) =>
  Effect.gen(function* () {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gram-confined-")));
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(base, { recursive: true })));
    const folder = join(base, "thread");
    const outside = join(base, "control-plane");
    mkdirSync(folder);
    mkdirSync(outside);
    writeFileSync(join(folder, "inside.txt"), "the thread's own");
    const files = {
      text: join(outside, "hostname.txt"),
      note: join(outside, "notes.md"),
      page: join(outside, "page.html"),
      image: join(outside, "shot.png"),
    };
    writeFileSync(files.text, "control-plane secret");
    writeFileSync(files.note, "# not yours");
    writeFileSync(files.page, "<h1>not yours</h1>");
    writeFileSync(files.image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const created = yield* runtimes.create({
      deferOpen: true,
      projectRoot: folder,
      checkout: { kind: "main", path: folder },
    });
    const thread = yield* store.insertThread({
      ...created,
      ...(options.dreamHost === undefined ? {} : { dreamHost: options.dreamHost }),
    });
    const named = Object.values(files);
    yield* store.upsertMessage(thread.id, {
      id: "m-named",
      role: "assistant",
      parts: [
        { type: "text", text: `Wrote ${named.join(" and ")}` },
        ...named.map((path, index) => ({
          type: "tool-Write",
          toolCallId: `c-${index}`,
          state: "output-available",
          input: { file_path: path, content: "" },
        })),
      ],
    } as unknown as GramUIMessage);
    return { threadId: thread.id as ThreadId, folder, files };
  });

/** Every preview of a path outside the thread's folders is refused, and resolving says nothing. */
const expectConfined = (options: { readonly dreamHost?: HostId } = {}) =>
  Effect.gen(function* () {
    const { threadId, files } = yield* vouchedThread(options);
    const handlers = yield* fsHandlers;
    for (const read of [
      Effect.asVoid(handlers["fs.file"]({ path: files.text, threadId })),
      Effect.asVoid(handlers["fs.image"]({ path: files.image, threadId })),
      Effect.asVoid(handlers["fs.preview"]({ path: files.note, threadId })),
      Effect.asVoid(handlers["fs.preview"]({ path: files.page, threadId })),
    ]) {
      expect(yield* Effect.flip(read)).toMatchObject({ _tag: "InvalidState" });
    }
    const resolved = yield* handlers["fs.resolve"]({ threadId, paths: [files.text, files.note] });
    expect(resolved.files).toEqual([]);
    expect((yield* handlers["fs.file"]({ path: "inside.txt", threadId })).content).toBe(
      "the thread's own",
    );
  });

describe("a preview outside a thread's folders", () => {
  it.effect("isn't vouched for by a transcript whose session runs on another machine", () =>
    expectConfined({ dreamHost: HostId.make("their-machine") }).pipe(
      Effect.scoped,
      Effect.provide(layerWith(TEST_CONFIG)),
    ),
  );

  it.effect("isn't vouched for by any transcript on a headless server", () =>
    expectConfined().pipe(
      Effect.scoped,
      Effect.provide(layerWith({ ...TEST_CONFIG, headless: true })),
    ),
  );

  it.effect("is still vouched for by its own transcript on a desktop", () =>
    Effect.gen(function* () {
      const { threadId, files } = yield* vouchedThread();
      const handlers = yield* fsHandlers;
      expect((yield* handlers["fs.file"]({ path: files.text, threadId })).content).toBe(
        "control-plane secret",
      );
    }).pipe(Effect.scoped, Effect.provide(layerWith(TEST_CONFIG))),
  );

  it.effect("never reads a deployment's secret, even one its messages name", () =>
    Effect.gen(function* () {
      const { threadId, files } = yield* vouchedThread();
      const handlers = yield* fsHandlers;
      for (const read of [
        Effect.asVoid(handlers["fs.file"]({ path: files.text, threadId })),
        Effect.asVoid(handlers["fs.image"]({ path: files.image, threadId })),
        Effect.asVoid(handlers["fs.preview"]({ path: files.note, threadId })),
      ]) {
        expect(yield* Effect.flip(read)).toMatchObject({
          _tag: "InvalidState",
          message: expect.stringContaining("credentials"),
        });
      }
      expect((yield* handlers["fs.resolve"]({ threadId, paths: [files.text] })).files).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.unwrap(
          Effect.sync(() => {
            const secrets = realpathSync(tmpdir());
            return layerWith({ ...TEST_CONFIG, secretPaths: [secrets] });
          }),
        ),
      ),
    ),
  );

  it.effect.skipIf(process.platform === "win32")(
    "never reads a secret inside the thread's folder, or one a link there leads to",
    () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "gram-secret-inside-")));
      const folder = join(base, "thread");
      const inside = join(folder, "secrets");
      const elsewhere = join(base, "mounted");
      mkdirSync(inside, { recursive: true });
      mkdirSync(elsewhere);
      writeFileSync(join(inside, "token"), "inside secret");
      writeFileSync(join(elsewhere, "token"), "mounted secret");
      symlinkSync(join(elsewhere, "token"), join(folder, "link.txt"));
      symlinkSync(join(inside, "token"), join(folder, "alias.txt"));
      writeFileSync(join(folder, "open.txt"), "the thread's own");
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(base, { recursive: true })));
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const created = yield* runtimes.create({
          deferOpen: true,
          projectRoot: folder,
          checkout: { kind: "main", path: folder },
        });
        const threadId = (yield* store.insertThread(created)).id as ThreadId;
        const handlers = yield* fsHandlers;
        for (const path of ["secrets/token", "alias.txt", "link.txt"]) {
          expect(yield* Effect.flip(handlers["fs.file"]({ path, threadId }))).toMatchObject({
            _tag: "InvalidState",
            message: expect.stringMatching(/credentials|outside/),
          });
        }
        expect(
          (yield* handlers["fs.resolve"]({ threadId, paths: ["alias.txt", "secrets/token"] }))
            .files,
        ).toEqual([]);
        expect((yield* handlers["fs.file"]({ path: "open.txt", threadId })).content).toBe(
          "the thread's own",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(layerWith({ ...TEST_CONFIG, secretPaths: [inside, elsewhere] })),
      );
    },
  );
});
