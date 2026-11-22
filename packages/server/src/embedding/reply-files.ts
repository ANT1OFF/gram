import {
  CONVERSATION_REPLY_FILES_BYTES_MAX,
  type ConversationReplyFile,
  effectiveCheckout,
  isLocalHost,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sanitizeAttachmentName } from "../attachments/attachments.ts";
import { sentMediaType, type SentFromMachines } from "../app-tools/file-tools.ts";
import { fetchSentFile } from "../host/file-reads.ts";
import { DAY_MS } from "../zone-time.ts";

/** A file a reply carries, read once before it is decided on, so what is sent is what was asked. */
export interface ReplyFile extends ConversationReplyFile {
  /** Where it was read, as the agent named it resolved. */
  readonly path: string;
  readonly bytes: Buffer;
}

/** How long a reply's files are kept for the host to read, after the reply. */
export const REPLY_FILES_KEPT_MS = 7 * DAY_MS;

const MANIFEST = "files.json";
const REPLY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const megabytes = (bytes: number) => Math.round(bytes / 2 ** 20);

/**
 * `<dataDir>/conversation-files`: a folder per reply, outside any thread's, so a worker that closes
 * as soon as it replied leaves the host its files.
 */
export const replyFilesDir = (dataDir: string): string => resolve(dataDir, "conversation-files");

const fileOf = (path: string, bytes: Buffer): ReplyFile => ({
  path,
  name: basename(path),
  mediaType: sentMediaType(path),
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes,
});

/**
 * Reads the files `paths` name for a reply from `thread`: on this machine relative to its folder,
 * or from the machine it runs on. A file that may hold credentials is refused, as `send_file`
 * refuses it, and so are files together over `CONVERSATION_REPLY_FILES_BYTES_MAX`.
 */
export const readReplyFiles = (
  thread: Thread,
  paths: ReadonlyArray<string>,
  machines: SentFromMachines | undefined,
): Effect.Effect<ReadonlyArray<ReplyFile>, string> =>
  Effect.gen(function* () {
    const root = effectiveCheckout(thread).path;
    const local = isLocalHost(effectiveCheckout(thread));
    if (!local && machines === undefined)
      return yield* Effect.fail(
        "This thread's files are on another machine, which can't send here.",
      );
    const reads = local
      ? undefined
      : yield* machines!.readsFor(thread).pipe(Effect.mapError((e) => e.message));
    const files: Array<ReplyFile> = [];
    let total = 0;
    for (const path of paths) {
      const left = CONVERSATION_REPLY_FILES_BYTES_MAX - total;
      const read = yield* (
        reads === undefined ? fetchSentFile(path, root, left) : reads.reads.fetch(path, root, left)
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "NotFound" ? `File not found: ${path}` : error.message,
        ),
      );
      const bytes = Buffer.from(read.data, "base64");
      if (bytes.length === 0) return yield* Effect.fail(`${path} is empty`);
      total += bytes.length;
      if (total > CONVERSATION_REPLY_FILES_BYTES_MAX)
        return yield* Effect.fail(
          `A reply's files come to at most ${megabytes(CONVERSATION_REPLY_FILES_BYTES_MAX)} MB together.`,
        );
      files.push(fileOf(read.path, bytes));
    }
    return files;
  });

const manifestOf = (files: ReadonlyArray<ReplyFile>) =>
  files.map(({ name, mediaType, size, sha256 }, index) => ({
    name,
    mediaType,
    size,
    sha256,
    file: `${index + 1}-${sanitizeAttachmentName(name)}`,
  }));

const pruneOld = async (dir: string, now: number) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const at = join(dir, entry.name);
    const info = await stat(at).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > REPLY_FILES_KEPT_MS)
      await rm(at, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Keeps a reply's files for the host under its reply id, and drops replies' files older than
 * `REPLY_FILES_KEPT_MS`. The same reply kept again keeps the same files. Answers where each is kept.
 */
export const keepReplyFiles = (
  dataDir: string,
  replyId: string,
  files: ReadonlyArray<ReplyFile>,
): Effect.Effect<ReadonlyArray<string>, string> =>
  files.length === 0
    ? Effect.succeed([])
    : Effect.tryPromise({
        try: async () => {
          const dir = replyFilesDir(dataDir);
          await pruneOld(dir, Date.now());
          const folder = join(dir, replyId);
          await mkdir(folder, { recursive: true });
          const manifest = manifestOf(files);
          const kept = manifest.map((entry) => join(folder, entry.file));
          for (const [index, each] of files.entries()) await writeFile(kept[index]!, each.bytes);
          await writeFile(join(folder, MANIFEST), JSON.stringify(manifest));
          return kept;
        },
        catch: () => "The reply's files couldn't be kept for sending.",
      });

/**
 * One of a reply's files as its host reads it back: what `conversation.reply` said of it and its
 * bytes, checked against its `sha256`. `undefined` for a reply, or a file, that isn't kept.
 */
export const readKeptReplyFile = (
  dataDir: string,
  replyId: string,
  index: number,
): Effect.Effect<(ConversationReplyFile & { readonly bytes: Buffer }) | undefined> =>
  Effect.promise(async () => {
    if (!REPLY_ID.test(replyId) || !Number.isInteger(index) || index < 0) return undefined;
    const folder = join(replyFilesDir(dataDir), replyId);
    try {
      const manifest = JSON.parse(await readFile(join(folder, MANIFEST), "utf8")) as ReturnType<
        typeof manifestOf
      >;
      const entry = manifest[index];
      if (entry === undefined || entry.file !== basename(entry.file)) return undefined;
      const bytes = await readFile(join(folder, entry.file));
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return undefined;
      return {
        name: entry.name,
        mediaType: entry.mediaType,
        size: bytes.length,
        sha256: entry.sha256,
        bytes,
      };
    } catch {
      return undefined;
    }
  });
