import { describe, expect, it } from "@effect/vitest";
import {
  InvalidState,
  NotFound,
  ThreadNotFound,
  type AttachmentUpload,
  type GramUIMessage,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  copyForkedAttachments,
  isAllowedAttachment,
  makeAttachments,
  readThreadAttachment,
  referencedAttachments,
  sanitizeAttachmentName,
} from "./attachments.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { canSymlink } from "../fs/test-symlinks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { attachmentHandlers } from "../rpc/handlers/attachments.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { storeToolImage } from "./tool-images.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const t1 = "t1" as ThreadId;

const setup = (maxBytes?: number) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-attachments-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const closed = yield* Queue.unbounded<ThreadId>();
    const attachments = yield* makeAttachments({
      dir,
      threadExists: (threadId) =>
        threadId === t1 ? Effect.void : Effect.fail(new ThreadNotFound({ threadId })),
      closedThreads: Stream.fromQueue(closed),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    return { dir, closed, attachments };
  });

const png = (overrides: Partial<AttachmentUpload> = {}): AttachmentUpload => ({
  threadId: t1,
  name: "image.png",
  mediaType: "image/png",
  data: PNG.toString("base64"),
  ...overrides,
});

describe("sanitizeAttachmentName", () => {
  it("keeps a safe basename", () => {
    expect(sanitizeAttachmentName("Screenshot 2026-09-16 at 10.00.00.png")).toBe(
      "Screenshot_2026-09-16_at_10.00.00.png",
    );
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("C:\\Users\\x\\notes.md")).toBe("notes.md");
    expect(sanitizeAttachmentName(".env")).toBe("env");
    expect(sanitizeAttachmentName("")).toBe("attachment");
  });
});

describe("isAllowedAttachment", () => {
  it("allows images and text, judging generic types by extension", () => {
    expect(isAllowedAttachment("a.png", "image/png")).toBe(true);
    expect(isAllowedAttachment("a.csv", "text/csv")).toBe(true);
    expect(isAllowedAttachment("a.json", "application/json")).toBe(true);
    expect(isAllowedAttachment("notes.md", "")).toBe(true);
    expect(isAllowedAttachment("dump.log", "application/octet-stream")).toBe(true);
    expect(isAllowedAttachment("a.zip", "application/zip")).toBe(false);
    expect(isAllowedAttachment("setup.exe", "")).toBe(false);
  });
});

describe("makeAttachments", () => {
  it.effect("stores an image under its thread and returns an absolute path", () =>
    Effect.gen(function* () {
      const { dir, attachments } = yield* setup();
      const attachment = yield* attachments.upload(png());
      expect(attachment).toMatchObject({ name: "image.png", mediaType: "image/png" });
      expect(attachment.path.startsWith(join(dir, "t1"))).toBe(true);
      expect(attachment.path).toMatch(/[0-9a-f]{8}-image\.png$/);
      expect(readFileSync(attachment.path)).toEqual(PNG);

      const again = yield* attachments.upload(png());
      expect(again.path).not.toBe(attachment.path);
    }),
  );

  it.effect(
    "rejects an unknown thread, a disallowed type, an empty file and an oversized one",
    () =>
      Effect.gen(function* () {
        const { attachments } = yield* setup(16);
        const fail = (overrides: Partial<AttachmentUpload>) =>
          attachments.upload(png(overrides)).pipe(Effect.flip);

        expect(yield* fail({ threadId: "gone" as ThreadId })).toBeInstanceOf(ThreadNotFound);
        expect(yield* fail({ name: "a.zip", mediaType: "application/zip" })).toBeInstanceOf(
          InvalidState,
        );
        expect(yield* fail({ data: "" })).toMatchObject({ message: "image.png is empty" });
        expect(yield* fail({})).toMatchObject({
          message: expect.stringContaining("attachment limit"),
        });
      }),
  );

  it.live("deletes a thread's attachments when the thread is removed", () =>
    Effect.gen(function* () {
      const { dir, closed, attachments } = yield* setup();
      const attachment = yield* attachments.upload(png());
      expect(existsSync(attachment.path)).toBe(true);

      yield* Queue.offer(closed, t1);
      for (let i = 0; i < 200 && existsSync(join(dir, "t1")); i++) yield* Effect.sleep("10 millis");
      expect(existsSync(join(dir, "t1"))).toBe(false);
    }),
  );
});

const message = (...urls: ReadonlyArray<string>): GramUIMessage => ({
  id: "m1",
  role: "user",
  parts: [
    { type: "text", text: "look at this" },
    ...urls.map((url) => ({ type: "file" as const, mediaType: "image/png", url })),
  ],
});

/** A temp folder with a `t1` attachments folder in it, removed once `f` has finished. */
const withFiles = async (f: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-attachment-read-"));
  mkdirSync(join(dir, "t1"));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const read = (messages: ReadonlyArray<GramUIMessage>, path: string, maxBytes?: number) =>
  Effect.runPromise(readThreadAttachment(messages, path, maxBytes));

const refusal = (messages: ReadonlyArray<GramUIMessage>, path: string) =>
  Effect.runPromise(Effect.flip(readThreadAttachment(messages, path)));

describe("readThreadAttachment", () => {
  it("serves an image one of the thread's messages references", async () => {
    await withFiles(async (dir) => {
      const path = join(dir, "t1", "0f0f0f0f-image.png");
      writeFileSync(path, PNG);
      const image = await read([message(pathToFileURL(path).href)], path);
      expect(image).toMatchObject({ mediaType: "image/png", tooLarge: false, size: PNG.length });
      expect(image.base64).toBe(PNG.toString("base64"));
    });
  });

  it("serves a referenced path spelt with a redundant segment", async () => {
    await withFiles(async (dir) => {
      const path = join(dir, "t1", "0f0f0f0f-my image.png");
      writeFileSync(path, PNG);
      const image = await read(
        [message(pathToFileURL(path).href)],
        `${dir}/t1/../t1/0f0f0f0f-my image.png`,
      );
      expect(image.tooLarge).toBe(false);
    });
  });

  it("refuses a path the thread never referenced, however it is spelt", async () => {
    await withFiles(async (dir) => {
      mkdirSync(join(dir, "t2"));
      const mine = join(dir, "t1", "0f0f0f0f-image.png");
      const theirs = join(dir, "t2", "1a1a1a1a-secret.png");
      const outside = join(dir, "secrets.png");
      for (const path of [mine, theirs, outside]) writeFileSync(path, PNG);
      const messages = [message(pathToFileURL(mine).href)];

      for (const path of [
        theirs,
        `${dir}/t1/../t2/1a1a1a1a-secret.png`,
        `${dir}/t1/../secrets.png`,
        `${dir}/t1/./../secrets.png`,
        outside,
        `${mine}.png`,
      ]) {
        const error = await refusal(messages, path);
        expect(error).toBeInstanceOf(InvalidState);
        expect(error.message).toBe("That file isn't attached to this thread");
      }
    });
  });

  it.skipIf(!canSymlink)(
    "refuses a symlink planted beside a referenced attachment (creating one needs a privilege on win32)",
    async () => {
      await withFiles(async (dir) => {
        const mine = join(dir, "t1", "0f0f0f0f-image.png");
        const outside = join(dir, "secrets.png");
        writeFileSync(mine, PNG);
        writeFileSync(outside, PNG);
        const link = join(dir, "t1", "0f0f0f0f-link.png");
        symlinkSync(outside, link);
        expect(await refusal([message(pathToFileURL(mine).href)], link)).toBeInstanceOf(
          InvalidState,
        );
      });
    },
  );

  it("refuses everything for a thread whose messages attached nothing", async () => {
    await withFiles(async (dir) => {
      const path = join(dir, "t1", "image.png");
      writeFileSync(path, PNG);
      expect(await refusal([], path)).toBeInstanceOf(InvalidState);
    });
  });

  it("refuses a format the preview can't read and reports a deleted attachment", async () => {
    await withFiles(async (dir) => {
      const heic = join(dir, "t1", "0f0f0f0f-photo.heic");
      const gone = join(dir, "t1", "1a1a1a1a-gone.png");
      writeFileSync(heic, PNG);
      const messages = [message(pathToFileURL(heic).href, pathToFileURL(gone).href)];
      expect(await refusal(messages, heic)).toBeInstanceOf(InvalidState);
      expect(await refusal(messages, gone)).toBeInstanceOf(NotFound);
    });
  });

  it("reports an attachment over the preview limit without its bytes", async () => {
    await withFiles(async (dir) => {
      const path = join(dir, "t1", "0f0f0f0f-big.png");
      writeFileSync(path, Buffer.alloc(64));
      const image = await read([message(pathToFileURL(path).href)], path, 16);
      expect(image).toMatchObject({ tooLarge: true, size: 64 });
      expect(image.base64).toBeUndefined();
    });
  });
});

const toolImagePart = (path?: string) => ({
  type: "data-tool-image" as const,
  data: {
    toolCallId: "call-1",
    mediaType: "image/png",
    size: 68,
    ...(path === undefined ? {} : { path }),
  },
});

const withToolImageDir = <A>(run: (dir: string) => Promise<A>) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-tool-images-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};
const pngImage = { toolCallId: "call-1", mediaType: "image/png", data: PNG.toString("base64") };

describe("referencedAttachments", () => {
  it("collects every file part's path and ignores what isn't a file URL", () => {
    const messages: ReadonlyArray<GramUIMessage> = [
      message(pathToFileURL("/tmp/a.png").href, "https://organization.example.invalid/b.png"),
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "nice" }] },
    ];
    expect([...referencedAttachments(messages)]).toEqual([resolve("/tmp/a.png")]);
  });

  it("collects the images stored for tool calls, and not one that was never stored", () => {
    const messages: ReadonlyArray<GramUIMessage> = [
      {
        id: "m1",
        role: "assistant",
        parts: [toolImagePart("/data/attachments/t1/tool-ab.png"), toolImagePart()],
      },
    ];
    expect([...referencedAttachments(messages)]).toEqual([
      resolve("/data/attachments/t1/tool-ab.png"),
    ]);
  });
});

describe("copyForkedAttachments", () => {
  it("repoints everything in the source's folder at the fork's, copied or not, and leaves the rest", () =>
    withToolImageDir(async (dir) => {
      const t2 = "t2" as ThreadId;
      mkdirSync(join(dir, t1), { recursive: true });
      const upload = join(dir, t1, "0f0f0f0f-shot.png");
      const stored = join(dir, t1, "tool-ab.png");
      writeFileSync(upload, PNG);
      writeFileSync(stored, PNG);
      const lost = join(dir, t1, "tool-lost.png");
      const messages: ReadonlyArray<GramUIMessage> = [
        message(pathToFileURL(upload).href, pathToFileURL("/repo/outside.png").href),
        { id: "m2", role: "assistant", parts: [toolImagePart(stored), toolImagePart(lost)] },
        { id: "m3", role: "assistant", parts: [{ type: "text", text: "untouched" }] },
      ];

      const changed = await Effect.runPromise(copyForkedAttachments(dir, t1, t2, messages));
      expect(changed.map((m) => m.id)).toEqual([messages[0]!.id, "m2"]);
      expect([...referencedAttachments(changed)].toSorted()).toEqual(
        [
          join(dir, t2, "0f0f0f0f-shot.png"),
          resolve("/repo/outside.png"),
          join(dir, t2, "tool-ab.png"),
          join(dir, t2, "tool-lost.png"),
        ].toSorted(),
      );
      expect(JSON.stringify(changed)).not.toContain(join(dir, t1));

      rmSync(join(dir, t1), { recursive: true, force: true });
      const image = await Effect.runPromise(
        readThreadAttachment(changed, join(dir, t2, "tool-ab.png")),
      );
      expect(image.base64).toBe(PNG.toString("base64"));
      // The one that couldn't be copied is a missing attachment, as it would be once `t1` closed.
      const missing = await Effect.runPromise(
        readThreadAttachment(changed, join(dir, t2, "tool-lost.png")).pipe(Effect.flip),
      );
      expect(missing).toBeInstanceOf(NotFound);
    }));

  it("owns a fork's files under a relative data dir too", () =>
    withToolImageDir(async (dir) => {
      const relativeDir = relative(process.cwd(), dir);
      const t2 = "t2" as ThreadId;
      const stored = await Effect.runPromise(storeToolImage(relativeDir, t1, pngImage));
      const messages: ReadonlyArray<GramUIMessage> = [
        { id: "m1", role: "assistant", parts: [toolImagePart(stored.data.path)] },
      ];
      const changed = await Effect.runPromise(copyForkedAttachments(relativeDir, t1, t2, messages));
      const [owned] = [...referencedAttachments(changed)];
      expect(owned?.startsWith(join(dir, t2))).toBe(true);
      rmSync(join(dir, t1), { recursive: true, force: true });
      expect((await Effect.runPromise(readThreadAttachment(changed, owned!))).base64).toBe(
        pngImage.data,
      );
    }));
});

describe("storeToolImage", () => {
  it("stores an image once per content under the thread's folder", () =>
    withToolImageDir(async (dir) => {
      const first = await Effect.runPromise(storeToolImage(dir, t1, pngImage));
      const again = await Effect.runPromise(storeToolImage(dir, t1, pngImage));
      expect(again).toEqual(first);
      expect(first.id.startsWith("call-1:")).toBe(true);
      expect(first.data).toMatchObject({ mediaType: "image/png", size: PNG.length });
      expect(first.data.path?.startsWith(join(dir, t1, "tool-"))).toBe(true);
      expect(readFileSync(first.data.path!)).toEqual(PNG);

      const other = await Effect.runPromise(
        storeToolImage(dir, t1, { ...pngImage, toolCallId: "c2" }),
      );
      expect(other.data.path).toBe(first.data.path);
      expect(other.id).not.toBe(first.id);
    }));

  it("describes without storing an image that is too large, of an unknown type, or unwritable", () =>
    withToolImageDir(async (dir) => {
      const tooLarge = await Effect.runPromise(storeToolImage(dir, t1, pngImage, 10));
      expect(tooLarge.data).toEqual({
        toolCallId: "call-1",
        mediaType: "image/png",
        size: PNG.length,
      });
      const heic = await Effect.runPromise(
        storeToolImage(dir, t1, { ...pngImage, mediaType: "image/heic" }),
      );
      expect(heic.data.path).toBeUndefined();
      expect(existsSync(join(dir, t1))).toBe(false);

      writeFileSync(join(dir, "blocked"), "");
      const unwritable = await Effect.runPromise(
        storeToolImage(join(dir, "blocked"), t1, pngImage),
      );
      expect(unwritable.data.path).toBeUndefined();
    }));
});

describe("attachmentHandlers", () => {
  it.live("deletes a removed thread's files however far a burst of events overflows", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "gram-attachments-hub-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
      );
      const layer = Layer.mergeAll(
        // Two events behind is an overflow, which a UI client resyncs from a snapshot.
        EventHub.layerWith({ serverEventCapacity: 2 }),
        ServerConfig.layer({ ...TEST_CONFIG, dataDir }),
        Layer.succeed(ThreadStore, { getThread: () => Effect.void } as never),
        Layer.succeed(ThreadRuntimes, { liveMessages: () => Effect.succeed([]) } as never),
      );
      yield* Effect.gen(function* () {
        const hub = yield* EventHub;
        const handlers = yield* attachmentHandlers;
        const { path } = yield* handlers["attachment.upload"](png());
        // The first removal keeps the cleanup busy deleting while the rest arrive.
        yield* hub.publish({ type: "thread.removed", threadId: "t0" as ThreadId });
        yield* hub.publish({ type: "thread.removed", threadId: t1 });
        for (const title of ["one", "two"]) {
          yield* hub.publish({ type: "notify", kind: "info", title });
        }
        yield* Effect.sync(() => existsSync(path)).pipe(
          Effect.repeat({ until: (exists) => !exists, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("10 seconds"),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("serves an image a message still streaming names, before it is stored", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "gram-attachments-live-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
      );
      const live: Array<GramUIMessage> = [];
      const layer = Layer.mergeAll(
        EventHub.layer,
        ServerConfig.layer({ ...TEST_CONFIG, dataDir }),
        Layer.succeed(ThreadStore, {
          getThread: () => Effect.void,
          listMessages: () => Effect.succeed([]),
        } as never),
        Layer.succeed(ThreadRuntimes, { liveMessages: () => Effect.succeed(live) } as never),
      );
      yield* Effect.gen(function* () {
        const handlers = yield* attachmentHandlers;
        const { path } = yield* handlers["attachment.upload"](png());
        const refused = yield* Effect.flip(handlers["attachment.read"]({ threadId: t1, path }));
        expect(refused._tag).toBe("InvalidState");
        live.push(message(pathToFileURL(path).href));
        const image = yield* handlers["attachment.read"]({ threadId: t1, path });
        expect(image.mediaType).toBe("image/png");
      }).pipe(Effect.provide(layer));
    }),
  );
});
