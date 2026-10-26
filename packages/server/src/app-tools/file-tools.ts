import { AppToolError, effectiveCheckout, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expandHome } from "../fs/folders.ts";
import { imageMediaType } from "../fs/images.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";

const MAX_FILES = 8;

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
  log: "text/plain",
};

/** A sent file's media type: an image the transcript previews, a known document, else bytes. */
export const sentMediaType = (path: string): string =>
  imageMediaType(path) ??
  MEDIA_TYPES[extname(path).slice(1).toLowerCase()] ??
  "application/octet-stream";

const fail = (message: string) => new AppToolError({ tool: "send_file", message });
const unknownThread = (threadId: ThreadId) => () => fail(`unknown thread ${threadId}`);

/**
 * `send_file`: puts files the agent made in front of the user, as `file` parts on its reply. Those
 * are the parts `attachment.read` serves back, so an image previews inline exactly as one the user
 * attached does. The file is referenced where it is, never copied, and may be outside the checkout:
 * a screenshot in a temp folder is the common case.
 */
export const sendFileTool = (
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: "send_file",
      class: "self",
      description:
        "Show the user files that already exist on disk, such as a screenshot, a diagram or a report, as cards in your reply; images preview inline. Paths are absolute or relative to the thread's folder. Use it for a deliverable worth looking at, not for working files.",
    },
    input: Schema.Struct({
      files: Schema.Array(Schema.NonEmptyString).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_FILES),
      ),
    }),
    handle: (threadId, { files }) =>
      Effect.gen(function* () {
        const thread = yield* store
          .getThread(threadId)
          .pipe(Effect.mapError(unknownThread(threadId)));
        const root = effectiveCheckout(thread).path;
        const sent: Array<{ path: string; size: number; mediaType: string }> = [];
        // Every path is checked before anything is shown, so a typo doesn't leave half the cards.
        for (const file of files) {
          const path = resolve(root, expandHome(file.trim()));
          const info = yield* Effect.tryPromise({
            try: () => stat(path),
            catch: () => fail(`File not found: ${file}`),
          });
          if (!info.isFile()) return yield* fail(`Not a file: ${file}`);
          sent.push({ path, size: info.size, mediaType: sentMediaType(path) });
        }
        for (const { path, mediaType } of sent) {
          yield* runtimes
            .emitChunk(threadId, { type: "file", url: pathToFileURL(path).href, mediaType })
            .pipe(Effect.mapError(unknownThread(threadId)));
        }
        return { sent };
      }),
  });
