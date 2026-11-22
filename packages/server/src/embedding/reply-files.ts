import {
  CONVERSATION_REPLY_FILES_BYTES_MAX,
  type ConversationReplyFile,
  effectiveCheckout,
  HOST_FILE_PART_BYTES,
  InvalidState,
  isCredentialPath,
  isLocalHost,
  type Thread,
} from "@gram/contracts";
import { realPath } from "@gram/git";
import * as Effect from "effect/Effect";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { sanitizeAttachmentName } from "../attachments/attachments.ts";
import { sentMediaType, type SentFromMachines } from "../app-tools/file-tools.ts";
import { expandHome } from "../fs/folders.ts";
import { openOutside, readUpTo } from "../fs/files.ts";
import type { HostFileReads } from "../host/file-reads.ts";
import { DAY_MS } from "../zone-time.ts";

/** A file a reply carries, read once before it is decided on, so what is sent is what was asked. */
export interface ReplyFile extends ConversationReplyFile {
  /** Where it was read, as the agent named it resolved. */
  readonly path: string;
  readonly bytes: Buffer;
}

/** How long a reply's files are kept for the host to read, after the reply. */
export const REPLY_FILES_KEPT_MS = 7 * DAY_MS;

const RECORD = "reply.json";
const REPLY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const megabytes = (bytes: number) => Math.round(bytes / 2 ** 20);
const digestOf = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

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
  sha256: digestOf(bytes),
  bytes,
});

const tooLarge = () =>
  `A reply's files come to at most ${megabytes(CONVERSATION_REPLY_FILES_BYTES_MAX)} MB together.`;
const notHere = (path: string) =>
  `${path} isn't in the thread's folder, so it can't be sent. Copy it there first.`;
const credentials = (path: string) => `Gram doesn't send files that may hold credentials: ${path}`;

const inside =
  (roots: ReadonlyArray<string>) =>
  (real: string): boolean =>
    roots.some((root) => real.startsWith(root.endsWith(sep) ? root : root + sep));

const readContainedHere = (
  path: string,
  roots: ReadonlyArray<string>,
  maxBytes: number,
): Effect.Effect<{ readonly path: string; readonly bytes: Buffer }, string> =>
  Effect.gen(function* () {
    const real = yield* Effect.promise(() =>
      Promise.all(roots.map((root) => realPath(root).catch(() => undefined))),
    );
    const target = resolve(roots[0]!, expandHome(path.trim()));
    const handle = yield* openOutside(
      target,
      {},
      inside(real.filter((root): root is string => root !== undefined)),
      { regularFile: true },
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "NotFound"
          ? `File not found: ${path}`
          : error.message.includes("credentials")
            ? credentials(path)
            : error.message.includes("isn't where it may be read from")
              ? notHere(path)
              : error.message,
      ),
    );
    const info = yield* Effect.tryPromise({
      try: () => handle.stat(),
      catch: () => `Can't open ${path}`,
    });
    if (info.size > maxBytes) return yield* Effect.fail(tooLarge());
    const bytes = yield* Effect.tryPromise({
      try: () => readUpTo(handle, maxBytes + 1),
      catch: () => `Can't read ${path}`,
    });
    if (bytes.length > maxBytes) return yield* Effect.fail(tooLarge());
    return { path: target, bytes };
  }).pipe(Effect.scoped);

const readInCheckoutThere = (
  reads: HostFileReads,
  machine: string,
  path: string,
  root: string,
  maxBytes: number,
): Effect.Effect<{ readonly path: string; readonly bytes: Buffer }, string> =>
  Effect.gen(function* () {
    const part = reads.part;
    if (part === undefined)
      return yield* Effect.fail(
        `gram-host on ${machine} is older than this Gram, so it can't send a reply's files. Update it.`,
      );
    if (isCredentialPath(path)) return yield* Effect.fail(credentials(path));
    const outside = { allowed: false, refusal: "isn't in the thread's folder" };
    const read = (offset: number) =>
      part(path, [root], outside, offset, HOST_FILE_PART_BYTES).pipe(
        Effect.mapError((error) =>
          error._tag === "NotFound"
            ? `File not found: ${path}`
            : error.message.includes("isn't in the thread's folder")
              ? notHere(path)
              : `${error.message} (on ${machine})`,
        ),
      );
    const first = yield* read(0);
    if (isCredentialPath(first.path)) return yield* Effect.fail(credentials(path));
    if (first.size > maxBytes) return yield* Effect.fail(tooLarge());
    const chunks = [Buffer.from(first.data, "base64")];
    let got = chunks[0]!.length;
    while (got < first.size) {
      const next = yield* read(got);
      const bytes = Buffer.from(next.data, "base64");
      if (next.size !== first.size || next.mtime !== first.mtime || bytes.length === 0)
        return yield* Effect.fail(`${path} changed while it was read; send it again.`);
      chunks.push(bytes);
      got += bytes.length;
    }
    return { path: first.path, bytes: Buffer.concat(chunks) };
  });

/**
 * Reads the files `paths` name for a reply from `thread`, only from its checkout, or on this
 * machine its own attachments folder `ownFolder` too: never from anywhere else the server or its
 * host can read. A file that may hold credentials is refused, and so are files together over
 * `CONVERSATION_REPLY_FILES_BYTES_MAX`.
 */
export const readReplyFiles = (
  thread: Thread,
  paths: ReadonlyArray<string>,
  machines: SentFromMachines | undefined,
  ownFolder: string,
): Effect.Effect<ReadonlyArray<ReplyFile>, string> =>
  Effect.gen(function* () {
    const checkout = effectiveCheckout(thread);
    const root = checkout.path;
    const local = isLocalHost(checkout);
    if (!local && machines === undefined)
      return yield* Effect.fail(
        "This thread's files are on another machine, which can't send here.",
      );
    const there = local
      ? undefined
      : yield* machines!.readsFor(thread).pipe(Effect.mapError((e) => e.message));
    const files: Array<ReplyFile> = [];
    let total = 0;
    for (const path of paths) {
      const left = CONVERSATION_REPLY_FILES_BYTES_MAX - total;
      const read = yield* there === undefined
        ? readContainedHere(path, [root, ownFolder], left)
        : readInCheckoutThere(there.reads, there.name, path, root, left);
      if (read.bytes.length === 0) return yield* Effect.fail(`${path} is empty`);
      total += read.bytes.length;
      files.push(fileOf(read.path, read.bytes));
    }
    return files;
  });

const recordOf = (text: string, files: ReadonlyArray<ReplyFile>) => ({
  text: digestOf(text),
  files: files.map(({ name, mediaType, size, sha256 }, index) => ({
    name,
    mediaType,
    size,
    sha256,
    file: `${index + 1}-${sanitizeAttachmentName(name)}`,
  })),
});
type ReplyRecord = ReturnType<typeof recordOf>;

const readRecord = async (folder: string): Promise<ReplyRecord | undefined> => {
  try {
    return JSON.parse(await readFile(join(folder, RECORD), "utf8")) as ReplyRecord;
  } catch {
    return undefined;
  }
};

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
 * Keeps a reply for the host under its reply id, once: its text's digest and its files, written
 * whole before they are named and never replaced. The same reply kept again answers the files
 * kept the first time; another text or other files under that id are refused, so an event once
 * sent always reads back the bytes it named. Replies older than `REPLY_FILES_KEPT_MS` are dropped.
 * Answers where each file is kept.
 */
export const keepReplyFiles = (
  dataDir: string,
  replyId: string,
  text: string,
  files: ReadonlyArray<ReplyFile>,
): Effect.Effect<ReadonlyArray<string>, InvalidState> =>
  Effect.tryPromise({
    try: async () => {
      const dir = replyFilesDir(dataDir);
      await mkdir(dir, { recursive: true });
      await pruneOld(dir, Date.now());
      const folder = join(dir, replyId);
      const record = recordOf(text, files);
      const keptAt = (kept: ReplyRecord) => kept.files.map((entry) => join(folder, entry.file));
      const same = (kept: ReplyRecord) => JSON.stringify(kept) === JSON.stringify(record);
      const before = await readRecord(folder);
      if (before !== undefined) return same(before) ? keptAt(before) : "differs";
      const staged = join(dir, `.${replyId}.${randomUUID()}`);
      await mkdir(staged);
      for (const [index, each] of files.entries())
        await writeFile(join(staged, record.files[index]!.file), each.bytes, { flag: "wx" });
      await writeFile(join(staged, RECORD), JSON.stringify(record), { flag: "wx" });
      try {
        await rename(staged, folder);
      } catch {
        await rm(staged, { recursive: true, force: true }).catch(() => undefined);
        const raced = await readRecord(folder);
        return raced !== undefined && same(raced) ? keptAt(raced) : "differs";
      }
      return keptAt(record);
    },
    catch: () => new InvalidState({ message: "The reply couldn't be kept for sending." }),
  }).pipe(
    Effect.flatMap((kept) =>
      kept === "differs"
        ? Effect.fail(
            new InvalidState({
              message:
                "This `key` already named another reply in this conversation. Give a new `key` for a different reply.",
            }),
          )
        : Effect.succeed(kept),
    ),
  );

/**
 * One of a reply's files as its host reads it back: what `conversation.reply` said of it and its
 * bytes, checked against its `sha256`. `undefined` for a reply, or a file, that isn't kept, and
 * for one kept longer than `REPLY_FILES_KEPT_MS`.
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
      const info = await stat(folder);
      if (Date.now() - info.mtimeMs > REPLY_FILES_KEPT_MS) return undefined;
      const record = await readRecord(folder);
      const entry = record?.files[index];
      if (entry === undefined || entry.file !== basename(entry.file)) return undefined;
      const bytes = await readFile(join(folder, entry.file));
      if (digestOf(bytes) !== entry.sha256) return undefined;
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
