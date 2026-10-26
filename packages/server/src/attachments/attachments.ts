import {
  InvalidState,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentUpload,
  type DraftId,
  type FileImage,
  type NotFound,
  type GramUIMessage,
  type ThreadId,
  type ThreadNotFound,
  type UserInput,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IMAGE_MAX_BYTES, readImage } from "../fs/images.ts";
import { realPath } from "@gram/git";
import { DAY_MS } from "../zone-time.ts";

/**
 * Where every thread's attachments live: a folder per thread, deleted with the thread. Absolute,
 * because `GRAM_DATA_DIR` may be relative and the paths stored in messages are compared, and
 * read back, as absolute ones.
 */
export const attachmentsDir = (dataDir: string): string => resolve(dataDir, "attachments");

/** Staging folders for `/new` drafts, under the attachments folder. */
const DRAFTS_DIR = "_drafts";

const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
]);

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".heic",
  ".txt",
  ".md",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".sh",
  ".sql",
  ".diff",
  ".patch",
]);

/** Images and text files. A file with no or a generic media type is judged by its extension. */
export const isAllowedAttachment = (name: string, mediaType: string): boolean => {
  const type = mediaType.toLowerCase();
  if (type.startsWith("image/") || type.startsWith("text/") || TEXT_MEDIA_TYPES.has(type)) {
    return true;
  }
  const generic = type === "" || type === "application/octet-stream";
  return generic && ALLOWED_EXTENSIONS.has(extname(name).toLowerCase());
};

/** The basename with anything outside `[A-Za-z0-9._-]` replaced and leading dots dropped. */
export const sanitizeAttachmentName = (raw: string): string => {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  const safe = base
    .replaceAll(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(-120);
  return safe === "" ? "attachment" : safe;
};

const invalid = (message: string) => new InvalidState({ message });

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

const resolvedFileUrl = (url: string): string | undefined => {
  try {
    return url.startsWith("file:") ? resolve(fileURLToPath(url)) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The attachment paths a thread's messages name, as resolved absolute paths: every `file` part's
 * URL, and every image the server stored for a tool call. Nothing outside this set may be read back
 * for the thread.
 */
export const referencedAttachments = (
  messages: ReadonlyArray<GramUIMessage>,
): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-tool-image") {
        if (part.data.path !== undefined) paths.add(resolve(part.data.path));
      } else if (part.type === "file") {
        const path = resolvedFileUrl(part.url);
        if (path !== undefined) paths.add(path);
      }
    }
  }
  return paths;
};

const realOrUndefined = (path: string) =>
  realPath(path).then(
    (p) => p,
    () => undefined,
  );

/**
 * Whether `messages` reference `path`. Both sides are compared as resolved absolute paths and then
 * as real paths, so `..`, a symlink or a re-encoded URL can't name a file the thread never had.
 */
export const isThreadAttachment = (
  messages: ReadonlyArray<GramUIMessage>,
  path: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const referenced = referencedAttachments(messages);
    if (referenced.size === 0) return false;
    if (referenced.has(resolve(path))) return true;
    const real = await realOrUndefined(resolve(path));
    if (real === undefined) return false;
    for (const candidate of referenced) {
      if ((await realOrUndefined(candidate)) === real) return true;
    }
    return false;
  });

/**
 * One of a thread's own attachments as base64, for the transcript's inline previews. A path the
 * thread's messages never referenced is refused before anything is read from disk; a referenced
 * path that is no longer there fails `NotFound`, and a non-image extension `InvalidState`.
 */
export const readThreadAttachment = (
  messages: ReadonlyArray<GramUIMessage>,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Effect.Effect<FileImage, NotFound | InvalidState> =>
  Effect.gen(function* () {
    if (!(yield* isThreadAttachment(messages, path))) {
      return yield* invalid("That file isn't attached to this thread");
    }
    return yield* readImage(path, maxBytes);
  });

/**
 * Gives a fork its own copy of every file its copied messages keep in the source thread's folder:
 * uploaded attachments and the images stored for tool calls. A thread's folder is deleted with the
 * thread, so a fork still pointing into its source's would lose its images when the source closes.
 * Returns the messages that now name the fork's copies, for the caller to store. A part is
 * repointed even when its file couldn't be copied: it then reads as a missing attachment at once,
 * which the transcript already shows for one, rather than working until the source happens to close.
 */
export const copyForkedAttachments = (
  dir: string,
  from: ThreadId,
  to: ThreadId,
  messages: ReadonlyArray<GramUIMessage>,
): Effect.Effect<ReadonlyArray<GramUIMessage>> =>
  Effect.gen(function* () {
    // Resolved, like the paths they are compared with: a relative `dir` would match nothing.
    const source = resolve(dir, from) + sep;
    const target = resolve(dir, to);
    const copies = new Map<string, string>();
    const failed: Array<string> = [];
    const copyOf = async (path: string | undefined): Promise<string | undefined> => {
      if (path === undefined || !resolve(path).startsWith(source)) return undefined;
      const known = copies.get(path);
      if (known !== undefined) return known;
      const copy = join(target, resolve(path).slice(source.length));
      copies.set(path, copy);
      await mkdir(dirname(copy), { recursive: true })
        .then(() => copyFile(path, copy))
        .catch(() => void failed.push(path));
      return copy;
    };

    const changed = yield* Effect.promise(() => repoint(messages, copyOf));
    if (failed.length > 0) {
      yield* Effect.logWarning("couldn't copy a fork's attachments").pipe(
        Effect.annotateLogs({ from, to, files: failed.length }),
      );
    }
    return changed;
  });

/** `messages` with each attachment path `copyOf` maps repointed; only the messages that changed. */
const repoint = async (
  messages: ReadonlyArray<GramUIMessage>,
  copyOf: (path: string | undefined) => Promise<string | undefined>,
): Promise<ReadonlyArray<GramUIMessage>> => {
  const changed: Array<GramUIMessage> = [];
  for (const message of messages) {
    let touched = false;
    const parts: Array<GramUIMessage["parts"][number]> = [];
    for (const part of message.parts) {
      if (part.type === "data-tool-image") {
        const path = await copyOf(part.data.path);
        parts.push(path === undefined ? part : { ...part, data: { ...part.data, path } });
        touched ||= path !== undefined;
      } else if (part.type === "file") {
        const path = await copyOf(resolvedFileUrl(part.url));
        parts.push(path === undefined ? part : { ...part, url: pathToFileURL(path).href });
        touched ||= path !== undefined;
      } else {
        parts.push(part);
      }
    }
    if (touched) changed.push({ ...message, parts });
  }
  return changed;
};

/**
 * Moves a draft's staged attachments into the thread's folder and points `input`'s attachments at
 * their new paths, before the first send. Attachments outside the draft's folder (a real path from
 * the desktop shell) are left as they are, and a draft with nothing staged is a no-op. A thread that
 * has a folder already (a task for a running orchestrator) takes the files in beside its own, whose
 * random prefixes keep the names apart. Resolves to the files moved, for `restoreDraftAttachments`.
 */
const adoptDraft = (
  dir: string,
  draftId: DraftId,
  threadId: ThreadId,
  input: UserInput | undefined,
): Effect.Effect<{ readonly input: UserInput | undefined; readonly moved: Moved }, InvalidState> =>
  Effect.tryPromise({
    try: async () => {
      const staged = join(dir, DRAFTS_DIR, draftId);
      if (!existsSync(staged)) return { input, moved: [] };
      const target = join(dir, threadId);
      let moved: Moved = "folder";
      if (existsSync(target)) {
        const names = await readdir(staged);
        const done: Array<string> = [];
        try {
          for (const name of names) {
            await rename(join(staged, name), join(target, name));
            done.push(name);
          }
        } catch (error) {
          // No half-adopted draft: what moved goes back, so the draft still has every file.
          for (const name of done) {
            await rename(join(target, name), join(staged, name)).catch(() => undefined);
          }
          throw error;
        }
        moved = names;
        // Everything is in the thread's folder by now; an empty folder left behind is pruned later.
        await rm(staged, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
          () => undefined,
        );
      } else {
        await rename(staged, target);
      }
      if (input?.attachments === undefined) return { input, moved };
      const prefix = staged + sep;
      const attachments = input.attachments.map((attachment) =>
        attachment.path.startsWith(prefix)
          ? { ...attachment, path: join(target, attachment.path.slice(prefix.length)) }
          : attachment,
      );
      return { input: { ...input, attachments }, moved };
    },
    catch: (error) => invalid(`Couldn't move the draft's attachments: ${failure(error)}`),
  });

/** What adopting a draft moved: its whole folder, or these files into a folder already there. */
type Moved = "folder" | ReadonlyArray<string>;

export const adoptDraftAttachments = (
  dir: string,
  draftId: DraftId,
  threadId: ThreadId,
  input: UserInput | undefined,
): Effect.Effect<UserInput | undefined, InvalidState> =>
  adoptDraft(dir, draftId, threadId, input).pipe(Effect.map((adopted) => adopted.input));

/** Moves adopted attachments back to their draft, or deletes them if they can't go back. */
const restoreDraftAttachments = (dir: string, draftId: DraftId, threadId: ThreadId, moved: Moved) =>
  Effect.tryPromise(async () => {
    const target = join(dir, threadId);
    const staged = join(dir, DRAFTS_DIR, draftId);
    if (moved === "folder") {
      if (!existsSync(target)) return;
      await rename(target, staged).catch(() =>
        rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      );
      return;
    }
    if (moved.length === 0) return;
    await mkdir(staged, { recursive: true });
    for (const name of moved) {
      await rename(join(target, name), join(staged, name)).catch(() =>
        rm(join(target, name), { force: true }),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("couldn't return a draft's attachments").pipe(
        Effect.annotateLogs({ threadId, draftId, cause: Cause.pretty(cause) }),
      ),
    ),
  );

/**
 * Runs `create` with the draft's attachments adopted into the thread's folder, new or already
 * there. When `create` fails, they go back to the draft so a retry with the same draft and input
 * still finds them.
 */
export const withDraftAttachments = <A, E, R>(
  dir: string,
  draftId: DraftId,
  threadId: ThreadId,
  input: UserInput | undefined,
  create: (input: UserInput | undefined) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InvalidState, R> =>
  adoptDraft(dir, draftId, threadId, input).pipe(
    Effect.flatMap((adopted) =>
      create(adopted.input).pipe(
        Effect.onError(() => restoreDraftAttachments(dir, draftId, threadId, adopted.moved)),
      ),
    ),
  );

/** Deletes draft staging folders untouched for `maxAgeMs`: drafts that never became threads. */
const pruneStaleDrafts = (dir: string, maxAgeMs: number, now: number) =>
  Effect.tryPromise(async () => {
    const drafts = join(dir, DRAFTS_DIR);
    const entries: Array<Dirent> = await readdir(drafts, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(drafts, entry.name);
      if (now - (await stat(path)).mtimeMs <= maxAgeMs) continue;
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("couldn't prune stale draft attachments").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
  );

export interface AttachmentsDeps {
  /** `<dataDir>/attachments`; each thread gets a folder under it, drafts one under `_drafts`. */
  readonly dir: string;
  readonly threadExists: (threadId: ThreadId) => Effect.Effect<void, ThreadNotFound>;
  /** Removed threads, whose attachments are deleted. */
  readonly closedThreads: Stream.Stream<ThreadId>;
  readonly maxBytes?: number;
  /** Draft staging folders older than this are deleted; a day by default. */
  readonly draftMaxAgeMs?: number;
  /** How often stale drafts are pruned after the one at start; hourly by default. */
  readonly draftPruneInterval?: Duration.Input;
  /** Runs after each prune, at start and on every interval. */
  readonly onPruned?: Effect.Effect<void>;
}

export interface Attachments {
  upload(request: AttachmentUpload): Effect.Effect<Attachment, ThreadNotFound | InvalidState>;
  remove(threadId: ThreadId): Effect.Effect<void>;
}

/** Stores uploaded attachments per thread and deletes a thread's folder when the thread is removed. */
export const makeAttachments = (
  deps: AttachmentsDeps,
): Effect.Effect<Attachments, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxBytes = deps.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const threadDir = (threadId: ThreadId) => join(deps.dir, threadId);
    const tooLarge = (name: string) =>
      invalid(
        `${name} is over the ${Math.max(1, Math.round(maxBytes / 2 ** 20))} MB attachment limit`,
      );

    const upload = (request: AttachmentUpload) =>
      Effect.gen(function* () {
        let dir: string;
        if (request.threadId !== undefined) {
          yield* deps.threadExists(request.threadId);
          dir = threadDir(request.threadId);
        } else if (request.draftId !== undefined) {
          dir = join(deps.dir, DRAFTS_DIR, request.draftId);
        } else {
          return yield* invalid("an upload needs a thread or a draft");
        }
        if (!isAllowedAttachment(request.name, request.mediaType)) {
          return yield* invalid(`Can't attach ${request.name}: only images and text files`);
        }
        // Base64 inflates by a third, so reject oversized payloads before decoding them.
        if (Math.floor((request.data.length * 3) / 4) > maxBytes + 2) {
          return yield* tooLarge(request.name);
        }
        const bytes = Buffer.from(request.data, "base64");
        if (bytes.length === 0) return yield* invalid(`${request.name} is empty`);
        if (bytes.length > maxBytes) return yield* tooLarge(request.name);

        const path = join(
          dir,
          `${randomUUID().slice(0, 8)}-${sanitizeAttachmentName(request.name)}`,
        );
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dir, { recursive: true });
            await writeFile(path, bytes);
          },
          catch: (error) => invalid(`Couldn't store ${request.name}: ${failure(error)}`),
        });
        const attachment: Attachment = {
          path,
          name: request.name,
          ...(request.mediaType === "" ? {} : { mediaType: request.mediaType }),
        };
        return attachment;
      });

    const remove = (threadId: ThreadId) =>
      Effect.tryPromise(() =>
        rm(threadDir(threadId), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't delete thread attachments").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    const prune = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => pruneStaleDrafts(deps.dir, deps.draftMaxAgeMs ?? DAY_MS, now)),
      Effect.andThen(deps.onPruned ?? Effect.void),
    );
    yield* prune;
    yield* Effect.sleep(deps.draftPruneInterval ?? "1 hour").pipe(
      Effect.andThen(prune),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* deps.closedThreads.pipe(Stream.runForEach(remove), Effect.forkScoped);
    return { upload, remove };
  });
