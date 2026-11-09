import {
  type FileImage,
  type FsFile,
  type FsResolveResult,
  type HostFetchedFile,
  InvalidState,
  isCredentialPath,
  MAX_ATTACHMENT_BYTES,
  type NotFound,
  type ThreadId,
} from "@gram/contracts";
import { Proc, type ProcShape } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeAttachmentName } from "../attachments/attachments.ts";
import { expandHome } from "../fs/folders.ts";
import {
  openOutside,
  readFilePreview,
  readPreview,
  readUpTo,
  resolveFileRefs,
  resolveScopedIn,
} from "../fs/files.ts";
import { readImage } from "../fs/images.ts";
import { makeVocabularySourcesCache } from "../fs/vocabulary.ts";
import { DAY_MS } from "../zone-time.ts";

/** What lets a preview outside a thread's folders through, as the control plane decided it. */
export interface OutsideAllowed {
  readonly allowed: boolean;
  readonly refusal: string;
}

/** What dictation reads from a checkout, its thread titles aside. */
export interface HostVocabularySources {
  readonly symbols: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly branches: ReadonlyArray<string>;
}

/**
 * A machine's files read for a thread placed on it: scoping a path to the thread's folders and
 * reading what it names, on the machine itself, with the same link, containment and credential
 * rules this machine's own previews keep. Which paths outside the folders the thread's transcript
 * vouches for is the control plane's to say (`OutsideAllowed`), since the transcript is kept there.
 */
export interface HostFileReads {
  readonly scope: (
    path: string,
    roots: ReadonlyArray<string>,
  ) => Effect.Effect<string, NotFound | InvalidState>;
  readonly file: (
    path: string,
    roots: ReadonlyArray<string>,
    outside: OutsideAllowed,
    maxBytes: number,
  ) => Effect.Effect<FsFile, NotFound | InvalidState>;
  readonly image: (
    path: string,
    roots: ReadonlyArray<string>,
    outside: OutsideAllowed,
    maxBytes: number,
  ) => Effect.Effect<FileImage, NotFound | InvalidState>;
  /** `unchecked` holds the absolute paths in no root that weren't in `outside`. */
  readonly resolve: (
    paths: ReadonlyArray<string>,
    roots: ReadonlyArray<string>,
    outside: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly files: FsResolveResult["files"]; readonly unchecked: ReadonlyArray<string> },
    InvalidState
  >;
  readonly vocabulary: (root: string) => Effect.Effect<HostVocabularySources, InvalidState>;
  readonly fetch: (
    path: string,
    cwd: string,
    maxBytes: number,
  ) => Effect.Effect<HostFetchedFile, NotFound | InvalidState>;
}

const gateOf = (outside: OutsideAllowed) => ({
  allows: Effect.succeed(outside.allowed),
  refusal: outside.refusal,
});

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 2 ** 20));

/** A file of at most `maxBytes` read through a checked handle, for `send_file`. */
const fetchFile = (
  path: string,
  cwd: string,
  maxBytes: number,
): Effect.Effect<HostFetchedFile, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const target = resolve(cwd, expandHome(path.trim()));
    if (isCredentialPath(path) || isCredentialPath(target)) {
      return yield* new InvalidState({
        message: `Gram doesn't send files that may hold credentials: ${path}`,
      });
    }
    const handle = yield* openOutside(target, {}, () => true, { regularFile: true });
    const tooLarge = new InvalidState({
      message: `${path} is over the ${megabytes(maxBytes)} MB a sent file may be`,
    });
    const info = yield* Effect.tryPromise({
      try: () => handle.stat(),
      catch: () => new InvalidState({ message: `Can't open ${path}` }),
    });
    if (info.size > maxBytes) return yield* tooLarge;
    const bytes = yield* Effect.tryPromise({
      try: () => readUpTo(handle, maxBytes + 1),
      catch: () => new InvalidState({ message: `Can't read ${path}` }),
    });
    if (bytes.length > maxBytes) return yield* tooLarge;
    return { path: target, size: bytes.length, data: bytes.toString("base64") };
  }).pipe(Effect.scoped);

/** The file reads of the machine this runs on, its git run through `proc`. */
export const fileReadsOn = (proc: ProcShape): HostFileReads => {
  const on = Effect.provideService(Proc, proc);
  const sources = makeVocabularySourcesCache();
  return {
    scope: (path, roots) => resolveScopedIn(path, roots),
    file: (path, roots, outside, maxBytes) =>
      readPreview(path, roots, gateOf(outside), (target, opened) =>
        readFilePreview(target, maxBytes, opened),
      ),
    image: (path, roots, outside, maxBytes) =>
      readPreview(path, roots, gateOf(outside), (target, opened) =>
        readImage(target, maxBytes, opened),
      ),
    resolve: (paths, roots, outside) =>
      Effect.gen(function* () {
        const allowed = new Set(outside);
        const unchecked = new Set<string>();
        const files = yield* on(
          resolveFileRefs(paths, roots, (path) =>
            Effect.sync(() => {
              if (allowed.has(path)) return true;
              unchecked.add(path);
              return false;
            }),
          ),
        );
        return { files, unchecked: [...unchecked] };
      }),
    vocabulary: (root) => on(sources(root)),
    fetch: fetchFile,
  };
};

/** How long the host keeps a thread's attachments after the last one arrived, unless told sooner. */
export const HOST_ATTACHMENTS_MAX_AGE_MS = 7 * DAY_MS;

/** A thread id as a folder name: only what an id can hold, never a path of its own. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The files users attach to the sessions on this machine, a folder per thread under `dir`. The
 * agent reads each where it is stored, so the bytes are here before its prompt names them. A
 * thread's folder goes when the control plane says the thread is gone, or once nothing has been
 * added to it for `maxAgeMs`, for a thread removed while this machine was offline.
 */
export interface HostAttachments {
  readonly put: (
    threadId: ThreadId,
    name: string,
    data: string,
  ) => Effect.Effect<{ readonly path: string }, InvalidState>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
}

export const attachmentsOnHost = (
  dir: string,
  options: {
    readonly maxBytes?: number;
    readonly maxAgeMs?: number;
    readonly pruneEvery?: Parameters<typeof Effect.sleep>[0];
    readonly now?: () => number;
  } = {},
): Effect.Effect<HostAttachments, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = resolve(dir);
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const maxAgeMs = options.maxAgeMs ?? HOST_ATTACHMENTS_MAX_AGE_MS;
    const now = options.now ?? Date.now;
    const folderOf = (threadId: ThreadId): Effect.Effect<string, InvalidState> =>
      SAFE_ID.test(threadId)
        ? Effect.succeed(join(root, threadId))
        : Effect.fail(new InvalidState({ message: `Not a thread id: ${threadId}` }));

    const put = (threadId: ThreadId, name: string, data: string) =>
      Effect.gen(function* () {
        const folder = yield* folderOf(threadId);
        const tooLarge = new InvalidState({
          message: `${name} is over the ${megabytes(maxBytes)} MB attachment limit`,
        });
        // Base64 inflates by a third, so an oversized payload is refused before it is decoded.
        if (Math.floor((data.length * 3) / 4) > maxBytes + 2) return yield* tooLarge;
        const bytes = Buffer.from(data, "base64");
        if (bytes.length === 0) return yield* new InvalidState({ message: `${name} is empty` });
        if (bytes.length > maxBytes) return yield* tooLarge;
        const path = join(folder, `${randomUUID().slice(0, 8)}-${sanitizeAttachmentName(name)}`);
        const partial = `${path}.partial`;
        // Written beside and then renamed, so a put given up on never leaves a file the agent reads.
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await writeFile(partial, bytes, { mode: 0o600 });
            await rename(partial, path);
          },
          catch: (error) =>
            new InvalidState({
              message: `Couldn't store ${name}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.promise(() => rm(partial, { force: true }).catch(() => undefined)),
          ),
        );
        return { path };
      });

    const remove = (threadId: ThreadId) =>
      folderOf(threadId).pipe(
        Effect.flatMap((folder) =>
          Effect.tryPromise(() =>
            rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't delete a thread's attachments on this machine").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    const prune = Effect.tryPromise(async () => {
      const entries: Array<Dirent> = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
        const folder = join(root, entry.name);
        const info = await stat(folder).catch(() => undefined);
        if (info === undefined || now() - info.mtimeMs <= maxAgeMs) continue;
        await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't prune old attachments on this machine").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );
    yield* prune;
    yield* Effect.sleep(options.pruneEvery ?? "1 hour").pipe(
      Effect.andThen(prune),
      Effect.forever,
      Effect.forkScoped,
    );
    return { put, remove };
  });
