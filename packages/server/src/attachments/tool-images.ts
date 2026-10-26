import type { ThreadId, ToolImageData } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openOutside, readUpTo, type OpenRace } from "../fs/files.ts";
import { IMAGE_MAX_BYTES } from "../fs/images.ts";
import { realPath } from "@gram/git";

/** Extensions `readImage` serves back, by the media type an agent reports. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface ToolImage {
  readonly toolCallId: string;
  readonly mediaType: string;
  /** Base64. */
  readonly data: string;
}

export interface StoredToolImage {
  /** Stable for the same bytes on the same call, so a repeated report replaces its part. */
  readonly id: string;
  readonly data: ToolImageData;
}

/**
 * Writes an image a tool call returned into the thread's attachments folder, which is deleted with
 * the thread, and describes it for a `data-tool-image` part. The file is named by content hash, so
 * an agent that reads one screenshot ten times stores it once.
 *
 * Nothing is stored, and `path` is left out, for an image over the preview limit (`attachment.read`
 * would refuse to serve it anyway), a media type the preview can't show, or a failed write: the
 * transcript then says an image was there rather than showing a broken one.
 */
export const storeToolImage = (
  attachmentsDir: string,
  threadId: ThreadId,
  image: ToolImage,
  maxBytes: number = IMAGE_MAX_BYTES,
  race: OpenRace = {},
): Effect.Effect<StoredToolImage> =>
  Effect.gen(function* () {
    const mediaType = image.mediaType.toLowerCase();
    const extension = EXTENSIONS[mediaType];
    // Base64 inflates by a third, so an oversized payload is sized without decoding it.
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const encodedSize = Math.floor((image.data.length * 3) / 4) - padding;
    const bytes = encodedSize > maxBytes ? undefined : Buffer.from(image.data, "base64");
    const size = bytes?.length ?? encodedSize;
    const hash = createHash("sha256")
      .update(bytes ?? image.data)
      .digest("hex")
      .slice(0, 16);
    const described = { toolCallId: image.toolCallId, mediaType, size };
    const id = `${image.toolCallId}:${hash}`;
    if (bytes === undefined || bytes.length === 0 || bytes.length > maxBytes) {
      return { id, data: described };
    }
    if (extension === undefined) return { id, data: described };

    const storage = resolve(attachmentsDir);
    const dir = join(storage, threadId);
    const path = join(dir, `tool-${hash}.${extension}`);
    // Thread IDs must name one child, never another owner or the storage root itself.
    if (basename(threadId) !== threadId || threadId === "." || threadId === "..") {
      return { id, data: described };
    }
    const verified = yield* Effect.gen(function* () {
      const parents = yield* Effect.tryPromise(async () => {
        await mkdir(storage, { recursive: true, mode: 0o700 });
        const expectedStorage = join(await realPath(dirname(storage)), basename(storage));
        const root = await lstat(storage, { bigint: true });
        if (!root.isDirectory() || (await realPath(storage)) !== expectedStorage) throw new Error();
        await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const owner = await lstat(dir, { bigint: true });
        const expectedDir = join(expectedStorage, threadId);
        if (
          !owner.isDirectory() ||
          owner.uid !== root.uid ||
          (await realPath(dir)) !== expectedDir
        ) {
          throw new Error();
        }
        return { root, owner, expectedStorage, expectedDir };
      });
      const checkParents = () =>
        Effect.tryPromise(async () => {
          for (const [named, expected, checked] of [
            [storage, parents.expectedStorage, parents.root],
            [dir, parents.expectedDir, parents.owner],
          ] as const) {
            const current = await lstat(named, { bigint: true });
            if (
              !current.isDirectory() ||
              current.dev !== checked.dev ||
              current.ino !== checked.ino ||
              (await realPath(named)) !== expected
            )
              throw new Error();
          }
        });
      if (race.checked) yield* Effect.tryPromise(race.checked);
      yield* checkParents();
      yield* Effect.tryPromise(async () => {
        try {
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      });
      yield* checkParents();
      // EEXIST is not evidence of content. Refuse links (including hard links), special files,
      // foreign owners and parent aliases, then compare bounded bytes through the checked fd.
      const named = yield* Effect.tryPromise(() => lstat(path, { bigint: true }));
      if (!named.isFile() || named.nlink !== 1n || named.uid !== parents.owner.uid) return false;
      const handle = yield* openOutside(
        path,
        { opened: race.opened },
        (real) => real === join(parents.expectedDir, basename(path)),
        { regularFile: true },
      );
      const opened = yield* Effect.tryPromise(() => handle.stat({ bigint: true }));
      if (
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        opened.size !== BigInt(bytes.length)
      ) {
        return false;
      }
      const existing = yield* Effect.tryPromise(() => readUpTo(handle, maxBytes + 1));
      if (!existing.equals(bytes)) return false;
      yield* checkParents();
      const final = yield* Effect.tryPromise(() => lstat(path, { bigint: true }));
      return (
        final.isFile() && final.nlink === 1n && final.dev === opened.dev && final.ino === opened.ino
      );
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => false),
    );
    return { id, data: verified ? { ...described, path } : described };
  });
