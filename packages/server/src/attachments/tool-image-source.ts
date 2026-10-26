import { isCredentialPath, type GramUIMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { openOutside, type OpenRace } from "../fs/files.ts";
import { IMAGE_MAX_BYTES, imageMediaType, readImage } from "../fs/images.ts";
import { referencedAttachments } from "./attachments.ts";
import { storeToolImage, type StoredToolImage } from "./tool-images.ts";
import { isInside, isPhysicallyInside, realPath, tryRealPath } from "@gram/git";

const protectedSource = (path: string): boolean =>
  isCredentialPath(path) ||
  /(?:^|[\\/])\.(?:claude|codex)(?:[\\/]|$)/i.test(path) ||
  /(?:^|[\\/])\.config[\\/]opencode(?:[\\/]|$)/i.test(path) ||
  /(?:^|[\\/])\.local[\\/]share[\\/]opencode(?:[\\/]|$)/i.test(path);

/** Reject text mislabeled with an image extension before saving it as preview bytes. */
const matchesMediaType = (bytes: Buffer, mediaType: string): boolean => {
  switch (mediaType) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "image/gif":
      return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "image/svg+xml":
      return /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.toString("utf8"));
    default:
      return false;
  }
};

/**
 * Capture at a live event, never by inspecting saved outputs. Without native admission, a source
 * must stay inside both checkout roots or be an exact attachment. A matching current native-read
 * capability admits only its exact external path, anchored to its real parent with no final link.
 * All modes keep credential/storage refusal and checked-open file identity across read races.
 */
export const captureToolImageSource = (
  dir: string,
  threadId: ThreadId,
  source: { readonly toolCallId: string; readonly path: string },
  roots: ReadonlyArray<string>,
  messages: ReadonlyArray<GramUIMessage>,
  race: OpenRace = {},
  nativeRead?: {
    readonly origin: "codex-image-view";
    readonly path: string;
    readonly isCurrent: () => boolean;
  },
): Effect.Effect<StoredToolImage | undefined> =>
  Effect.gen(function* () {
    if (!isAbsolute(source.path) || imageMediaType(source.path) === undefined) return;
    const native = nativeRead?.origin === "codex-image-view" && nativeRead.path === source.path;
    if (nativeRead !== undefined && (!native || !nativeRead.isCurrent())) return;
    const current = () => nativeRead === undefined || nativeRead.isCurrent();
    const target = resolve(source.path);
    if (protectedSource(target)) return;
    // A root holds the target by where both really are, so the canonical path of an image inside a
    // root opened through a link counts, or as written for a root that no longer resolves. The
    // real-path check at the open below is what admits the file.
    const holds = yield* Effect.promise(() =>
      Promise.all(
        roots.map(
          async (root) => isInside(resolve(root), target) || isPhysicallyInside(root, target),
        ),
      ),
    );
    const containing = roots.filter((_, index) => holds[index]);
    const attached = referencedAttachments(messages).has(target);
    const storage = resolve(dir);
    if (isInside(storage, target) && !attached) return;
    if (containing.length === 0 && !attached && !native) return;
    const realRoots = yield* Effect.promise(() =>
      Promise.all(containing.map((root) => tryRealPath(root))),
    );
    const realStorage = yield* Effect.promise(() => tryRealPath(storage));
    // Normalize parent aliases such as macOS /tmp while refusing a final link for exact-path
    // admission. Keep both the real name and directory identity through the checked read.
    const exactParent =
      native || (attached && containing.length === 0)
        ? yield* Effect.tryPromise(() => realPath(dirname(target)))
        : undefined;
    const parentIdentity =
      exactParent === undefined
        ? undefined
        : yield* Effect.tryPromise(() => lstat(exactParent, { bigint: true }));
    if (parentIdentity !== undefined && !parentIdentity.isDirectory()) return;
    const parentCurrent = () =>
      Effect.tryPromise(async () => {
        if (exactParent === undefined || parentIdentity === undefined) return true;
        if ((await realPath(dirname(target))) !== exactParent) return false;
        const again = await lstat(exactParent, { bigint: true });
        return (
          again.isDirectory() &&
          again.dev === parentIdentity.dev &&
          again.ino === parentIdentity.ino
        );
      });
    const opened = yield* openOutside(
      target,
      race,
      (real) => {
        if (!current() || protectedSource(real)) return false;
        if (realStorage !== undefined && isInside(realStorage, real) && !attached) return false;
        return exactParent !== undefined
          ? real === join(exactParent, basename(target))
          : realRoots.some((root) => root !== undefined && isInside(root, real));
      },
      { regularFile: true },
    );
    const image = yield* readImage(target, IMAGE_MAX_BYTES, opened);
    if (!(yield* parentCurrent()) || !current()) return;
    if (image.tooLarge) {
      return {
        id: `${source.toolCallId}:source`,
        data: { toolCallId: source.toolCallId, mediaType: image.mediaType, size: image.size },
      };
    }
    if (image.base64 === undefined) return;
    if (!matchesMediaType(Buffer.from(image.base64, "base64"), image.mediaType)) return;
    return yield* storeToolImage(dir, threadId, {
      toolCallId: source.toolCallId,
      mediaType: image.mediaType,
      data: image.base64,
    });
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );
