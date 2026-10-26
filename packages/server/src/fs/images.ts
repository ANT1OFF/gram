import { open, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { InvalidState, NotFound, type FileImage } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readUpTo } from "./files.ts";

/** Images bigger than this come back `tooLarge`, without bytes; `fs.image` never reads more. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The preview media type for an image path; `undefined` for anything else. */
export const imageMediaType = (path: string): string | undefined =>
  MEDIA_TYPES[extname(path).slice(1).toLowerCase()];

const notFound = (path: string) =>
  new NotFound({ entity: "file", id: path, message: `File not found: ${path}` });

/**
 * An image as base64 for the Files panel, read through one handle: `opened` when the caller checked
 * and opened the file, else `path` opened here. Only the known image extensions are served, so this
 * can't be used to read arbitrary files as bytes; the renderer shows SVG through `<img>`, never
 * inline.
 */
export const readImage = (
  path: string,
  maxBytes: number,
  opened?: FileHandle,
): Effect.Effect<FileImage, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) {
      return yield* new InvalidState({ message: `Not a previewable image: ${path}` });
    }
    const handle =
      opened ??
      (yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => open(path, "r"), catch: () => notFound(path) }),
        (file) => Effect.promise(() => file.close()),
      ));
    const info = yield* Effect.tryPromise({
      try: () => handle.stat(),
      catch: () => notFound(path),
    });
    if (info.isDirectory()) return yield* new InvalidState({ message: `Is a folder: ${path}` });
    if (info.size > maxBytes) return { path, mediaType, size: info.size, tooLarge: true };
    // At most one byte past the limit, so an image that grew since `stat` is still cut off there.
    const bytes = yield* Effect.tryPromise({
      try: () => readUpTo(handle, maxBytes + 1),
      catch: () => new InvalidState({ message: `Can't read ${path}` }),
    });
    const size = Math.max(info.size, bytes.length);
    if (size > maxBytes) return { path, mediaType, size, tooLarge: true };
    return { path, mediaType, size, tooLarge: false, base64: bytes.toString("base64") };
  }).pipe(Effect.scoped);
