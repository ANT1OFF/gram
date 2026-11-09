import {
  AppToolError,
  effectiveCheckout,
  isLocalHost,
  MAX_ATTACHMENT_BYTES,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeAttachmentName } from "../attachments/attachments.ts";
import { expandHome } from "../fs/folders.ts";
import { imageMediaType } from "../fs/images.ts";
import type { HostFileReads } from "../host/file-reads.ts";
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
 * How `send_file` reaches the files of a thread on another machine: that machine's reads (absent
 * for one whose host is too old, or while it can't be reached, with why), and where this
 * machine keeps the threads' attachments, which the copies it shows go in.
 */
export interface SentFromMachines {
  readonly readsFor: (
    thread: Thread,
  ) => Effect.Effect<{ readonly name: string; readonly reads: HostFileReads }, AppToolError>;
  /** `<dataDir>/attachments`, a folder per thread, deleted with the thread. */
  readonly dir: string;
}

/**
 * The files a thread on another machine sends, read there and copied into the thread's own
 * attachments here, which the transcript reads them from: a path of this machine's is never
 * looked up for them. Every file is fetched before any is shown.
 */
const sendFromMachine = (
  threadId: ThreadId,
  thread: Thread,
  files: ReadonlyArray<string>,
  machines: SentFromMachines,
) =>
  Effect.gen(function* () {
    const { name, reads } = yield* machines.readsFor(thread);
    const root = effectiveCheckout(thread).path;
    const fetched = yield* Effect.forEach(files, (file) =>
      reads
        .fetch(file, root, MAX_ATTACHMENT_BYTES)
        .pipe(Effect.mapError((error) => fail(`${error.message} (on ${name})`))),
    );
    const copies: Array<{ path: string; copy: string; size: number; mediaType: string }> = [];
    for (const file of fetched) {
      const named = sanitizeAttachmentName(basename(file.path));
      // A folder of its own keeps the file's name, which the card shows.
      const copy = join(machines.dir, threadId, "sent", randomUUID().slice(0, 8), named);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(join(copy, ".."), { recursive: true });
          await writeFile(copy, Buffer.from(file.data, "base64"));
        },
        catch: () => fail(`Couldn't keep a copy of ${file.path} from ${name}`),
      });
      copies.push({ path: file.path, copy, size: file.size, mediaType: sentMediaType(file.path) });
    }
    return copies;
  });

/**
 * `send_file`: puts files the agent made in front of the user, as `file` parts on its reply. Those
 * are the parts `attachment.read` serves back, so an image previews inline exactly as one the user
 * attached does. The file is referenced where it is, never copied, and may be outside the checkout:
 * a screenshot in a temp folder is the common case.
 */
export const sendFileTool = (
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
  store: Pick<ThreadStoreShape, "getThread">,
  /** For threads on other machines; without it, such a thread's files are refused. */
  machines?: SentFromMachines,
) =>
  defineAppTool({
    descriptor: {
      name: "send_file",
      class: "self",
      description:
        "Show the user files already on disk, such as a screenshot, a diagram or a report, as cards in your reply; images preview inline. Paths are absolute or relative to the thread's folder. For a deliverable worth looking at, not for working files.",
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
        if (!isLocalHost(effectiveCheckout(thread))) {
          if (machines === undefined) {
            return yield* fail(
              "This thread's files are on another machine, which can't send here.",
            );
          }
          const copies = yield* sendFromMachine(threadId, thread, files, machines);
          for (const { copy, mediaType } of copies) {
            yield* runtimes
              .emitChunk(threadId, { type: "file", url: pathToFileURL(copy).href, mediaType })
              .pipe(Effect.mapError(unknownThread(threadId)));
          }
          return {
            sent: copies.map(({ path, size, mediaType }) => ({ path, size, mediaType })),
          };
        }
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
