import type { FileHandle } from "node:fs/promises";
import {
  checkoutRoots,
  effectiveCheckout,
  previewFileKind,
  FileRpcs,
  FsError,
  InvalidState,
  isCredentialPath,
  NotFound,
  type ThreadId,
} from "@gram/contracts";
import { isInside, Proc, realPath, tryRealPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { dirname, resolve } from "node:path";
import {
  FILE_MAX_BYTES,
  FILE_MAX_BYTES_CEILING,
  LIST_LIMIT,
  listFolder,
  mentionForms,
  mentionHints,
  outsideRoots,
  openOutside,
  readFilePreview,
  resolveFileRefs,
  resolveScoped,
  resolveScopedIn,
  writesPath,
} from "../../fs/files.ts";
import { browseFolders, expandHome } from "../../fs/folders.ts";
import { IMAGE_MAX_BYTES, readImage } from "../../fs/images.ts";
import { listFileNames } from "../../fs/names.ts";
import { SEARCH_MAX_PAGE, SEARCH_PAGE, searchFiles } from "../../fs/search.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { filesWrittenBy, PreviewFiles } from "../../preview/files.ts";
import { logDefects, type Handlers } from "./common.ts";
import { editorHandlers } from "./editor.ts";
import { outputHandlers } from "./outputs.ts";

/**
 * `target`'s real path, for granting its folder to a page: inside one of `roots`, resolved, or
 * for a file outside them, in the folder it was written to, not one a link of its own leads to.
 * `urlFor` takes it only while it still resolves to itself, so the folder checked is the folder
 * granted.
 */
const pageFolderCheck = (target: string, outside: boolean, roots: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const real = await realPath(target);
      if (outside) return (await realPath(dirname(target))) === dirname(real) ? real : undefined;
      for (const root of roots) {
        const realRoot = await tryRealPath(root);
        if (realRoot !== undefined && isInside(realRoot, real)) return real;
      }
      return undefined;
    },
    catch: () =>
      new NotFound({ entity: "file", id: target, message: `${target} no longer exists` }),
  }).pipe(
    Effect.flatMap((real) =>
      real === undefined
        ? Effect.fail(new InvalidState({ message: `${target} changed while it was checked` }))
        : Effect.succeed(real),
    ),
  );

/** `path` as spelled, `~` expanded and normalized, never through a link; case counts but on Windows. */
const namedPathKey = (path: string) => {
  const resolved = resolve(expandHome(path.trim()));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * Whether `written`, as a Write named it, is the path `target` names, by `namedPathKey`: a written
 * path retargeted at another file afterwards doesn't vouch for that file.
 */
const sameNamedPath = (written: string, target: string): boolean =>
  namedPathKey(written) === namedPathKey(target);

/** Previews name the thread whose transcript or checkouts they come from. */
const noThread = () => new InvalidState({ message: "Open a file from a thread to preview it" });

/**
 * `fs.browse` for the project picker, `fs.tree` over it, `fs.list` / `fs.file` / `fs.search` for the
 * Files panel, `fs.resolve` for the transcript's file links, and `fs.image` for image previews.
 */
export const fsHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const proc = yield* Proc;

  const threadOf = (threadId: ThreadId) =>
    store
      .getThread(threadId)
      .pipe(
        Effect.catchTag("ThreadNotFound", () =>
          Effect.fail(new InvalidState({ message: "This thread no longer exists", threadId })),
        ),
      );
  // Absent in handler-only test layers, where no HTML is previewed.
  const previewFiles = Option.getOrUndefined(yield* Effect.serviceOption(PreviewFiles));

  /** The checkout a `threadId` scopes paths to; none without a thread. */
  const scopeRoot = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(undefined)
      : threadOf(threadId).pipe(Effect.map((thread) => effectiveCheckout(thread).path));

  /** Whether `threadId`'s messages write `path` in their text, in any of its forms. */
  const mentioned = (threadId: ThreadId, path: string) =>
    Effect.gen(function* () {
      const forms = mentionForms(path);
      const texts = yield* store.messageTextsWith(threadId, [...forms, ...mentionHints(forms)]);
      return texts.some((text) => writesPath(text, forms));
    });
  /**
   * Whether `threadId`'s own Write or Edit calls named `path`, in any of its `mentionForms`, and
   * finished: the narrower rule the Preview tab holds a file outside the thread's folders to, since
   * an HTML page shown from there can load the files beside it. A turn still running counts too,
   * since its finished parts reach the transcript before they are all stored.
   */
  const wrote = (threadId: ThreadId, path: string) =>
    Effect.gen(function* () {
      const forms = mentionForms(path);
      const target = resolve(expandHome(path.trim()));
      const stored = yield* store.messagesWith(threadId, forms);
      const messages = [...stored, ...(yield* runtimes.liveMessages(threadId))];
      return messages.some(
        (message) =>
          message.role === "assistant" &&
          filesWrittenBy(message).some((written) => sameNamedPath(written, target)),
      );
    });
  /**
   * A gate for a path outside a thread's folders: named in its messages, in their text or by a
   * finished Write or Edit, unless the caller asks for `wrote` alone.
   */
  type Gate = { readonly allows: typeof mentioned; readonly refusal: string };
  const inMessages: Gate = {
    allows: (threadId, path) =>
      mentioned(threadId, path).pipe(
        Effect.flatMap((said) => (said ? Effect.succeed(true) : wrote(threadId, path))),
      ),
    refusal: "is outside this thread's folder and not in its messages",
  };
  const writtenByThread: Gate = {
    allows: wrote,
    refusal: "is outside this thread's folders, and the thread didn't write it",
  };
  /**
   * The file `path` names for a preview in `threadId`: in `roots` through `resolveScopedIn`, or an
   * absolute path outside them only when `gate` allows it. `outside` says which, so the caller
   * reads it through `openOutside`.
   */
  const previewPath = (
    path: string,
    threadId: ThreadId,
    roots: ReadonlyArray<string>,
    gate: Gate,
  ) =>
    Effect.gen(function* () {
      if (!(yield* outsideRoots(path, roots))) {
        return { target: yield* resolveScopedIn(path, roots), outside: false };
      }
      // Refused before the transcript is asked: whether a message names it changes nothing.
      if (isCredentialPath(path)) {
        return yield* new InvalidState({
          message: `Gram doesn't preview files that may hold credentials: ${path}`,
        });
      }
      if (!(yield* gate.allows(threadId, path))) {
        return yield* new InvalidState({
          message: `${path} ${gate.refusal}`,
        });
      }
      return { target: yield* resolveScoped(path, undefined), outside: true };
    });
  /**
   * Reads `path` for a preview in `threadId` with `read`, where `previewPath` allows it; outside
   * `roots` through `openOutside`, which refuses a credential file and hands `read` the very file
   * it checked. A path an agent wrote is all the renderer may read outside the checkouts, so a
   * renderer made to ask for anything else is refused.
   */
  const preview = <A>(
    path: string,
    threadId: ThreadId,
    roots: ReadonlyArray<string>,
    read: (target: string, opened?: FileHandle) => Effect.Effect<A, NotFound | InvalidState>,
    gate: Gate = inMessages,
  ) =>
    Effect.gen(function* () {
      const { target, outside } = yield* previewPath(path, threadId, roots, gate);
      return yield* read(target, outside ? yield* openOutside(target) : undefined);
    }).pipe(Effect.scoped);

  return {
    "fs.browse": ({ path, limit }) => browseFolders(path, limit === undefined ? {} : { limit }),

    /** `path`, when given, is the typed text to complete; otherwise `root` is listed. */
    "fs.tree": ({ root, path }) => {
      const input = path ?? (root.endsWith("/") ? root : `${root}/`);
      return browseFolders(input).pipe(
        Effect.map((listing) => ({
          root: listing.path,
          path: input,
          entries: listing.entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            kind: "dir" as const,
          })),
        })),
        // `fs.tree` only declares `FsError`; carry the friendly message in it.
        Effect.mapError(
          (error) =>
            new FsError({
              path: error instanceof NotFound ? error.id : input,
              message: error.message,
            }),
        ),
      );
    },

    "fs.list": ({ path, threadId, showHidden, limit }) =>
      Effect.gen(function* () {
        const target = yield* resolveScoped(path, yield* scopeRoot(threadId));
        return yield* listFolder(target, {
          showHidden: showHidden ?? false,
          limit: limit ?? LIST_LIMIT,
        }).pipe(Effect.provideService(Proc, proc));
      }),

    "fs.file": ({ path, threadId, maxBytes }) =>
      Effect.gen(function* () {
        if (threadId === undefined) return yield* noThread();
        const limit = Math.min(maxBytes ?? FILE_MAX_BYTES, FILE_MAX_BYTES_CEILING);
        // A worker spanning repos has files in its other worktrees too, which a file link opens.
        return yield* preview(
          path,
          threadId,
          checkoutRoots(yield* threadOf(threadId)),
          (target, opened) => readFilePreview(target, limit, opened),
        );
      }),

    "fs.search": ({ threadId, query, regex, caseSensitive, offset, limit }) =>
      Effect.gen(function* () {
        const checkout = yield* scopeRoot(threadId);
        const root = yield* resolveScoped(".", checkout);
        return yield* searchFiles(root, query, {
          regex: regex ?? false,
          caseSensitive: caseSensitive ?? false,
          offset: offset ?? 0,
          limit: Math.min(limit ?? SEARCH_PAGE, SEARCH_MAX_PAGE),
        }).pipe(Effect.provideService(Proc, proc));
      }),

    "fs.files": ({ threadId, path }) =>
      Effect.gen(function* () {
        const root = yield* resolveScoped(path ?? ".", yield* scopeRoot(threadId));
        return yield* listFileNames(root).pipe(Effect.provideService(Proc, proc));
      }),

    "fs.resolve": ({ threadId, paths }) =>
      Effect.gen(function* () {
        const roots = checkoutRoots(yield* threadOf(threadId));
        const files = yield* resolveFileRefs(paths, roots, (path) =>
          mentioned(threadId, path),
        ).pipe(Effect.provideService(Proc, proc));
        return { files };
      }),

    "fs.preview": ({ threadId, path }) =>
      Effect.gen(function* () {
        const kind = previewFileKind(path);
        if (kind === undefined) {
          return yield* new InvalidState({ message: `${path} isn't Markdown or HTML` });
        }
        const thread = yield* threadOf(threadId);
        const roots = [...checkoutRoots(thread), ...(thread.additionalDirectories ?? [])];
        if (kind === "html") {
          if (previewFiles === undefined) {
            return yield* new InvalidState({ message: "HTML previews aren't available here" });
          }
          // The listener opens each file it serves through `openOutside`, this page included.
          const { target, outside } = yield* previewPath(path, threadId, roots, writtenByThread);
          const real = yield* pageFolderCheck(target, outside, roots);
          return { kind, path: target, url: yield* previewFiles.urlFor(real) } as const;
        }
        const file = yield* preview(
          path,
          threadId,
          roots,
          (target, opened) => readFilePreview(target, FILE_MAX_BYTES, opened),
          writtenByThread,
        );
        if (file.content === undefined) {
          return yield* new InvalidState({
            message: file.binary ? `${path} isn't text` : `${path} is too large to preview`,
          });
        }
        return { kind, path: file.path, content: file.content } as const;
      }),

    "fs.image": ({ path, threadId, maxBytes }) =>
      Effect.gen(function* () {
        // A relative path is the checkout's; an absolute one may be in any folder of the thread's,
        // since a file link opens images in a multi-repo worker's other worktrees too.
        if (threadId === undefined) return yield* noThread();
        const thread = yield* threadOf(threadId);
        const roots = [...new Set([thread.checkout.path, ...checkoutRoots(thread)])];
        return yield* preview(path, threadId, roots, (target, opened) =>
          readImage(target, Math.min(maxBytes ?? IMAGE_MAX_BYTES, IMAGE_MAX_BYTES), opened),
        );
      }),
  } satisfies Partial<Handlers>;
});

/** The files group's handler layer: these, `editor.open` / `fs.reveal` and `workspace.outputs`. */
export const FileHandlersLive = FileRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* fsHandlers),
      ...(yield* editorHandlers),
      ...(yield* outputHandlers),
    };
    return FileRpcs.of(logDefects(FileRpcs, handlers));
  }),
);
