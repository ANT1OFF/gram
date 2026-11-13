import type { FileHandle } from "node:fs/promises";
import {
  checkoutRoots,
  effectiveCheckout,
  hostOf,
  isLocalHost,
  previewFileKind,
  FileRpcs,
  FsError,
  InvalidState,
  NotFound,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolve } from "node:path";
import {
  FILE_MAX_BYTES,
  FILE_MAX_BYTES_CEILING,
  LIST_LIMIT,
  mayBeOutside,
  mentionForms,
  mentionHints,
  type OutsideGate,
  previewTarget,
  readFilePreview,
  readPreview,
  resolveFileRefs,
  resolveScoped,
  writesPath,
} from "../../fs/files.ts";
import { browseFolders, expandHome } from "../../fs/folders.ts";
import { IMAGE_MAX_BYTES, readImage } from "../../fs/images.ts";
import { makeVocabularyCache, projectTerms } from "../../fs/vocabulary.ts";
import type { HostFileReads, OutsideAllowed } from "../../host/file-reads.ts";
import { machineNames } from "../../host/machine-name.ts";
import { SEARCH_MAX_PAGE, SEARCH_PAGE } from "../../fs/search.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { filesWrittenBy, pageFolderCheck, PreviewFiles } from "../../preview/files.ts";
import { logDefects, type Handlers } from "./common.ts";
import { editorHandlers } from "./editor.ts";
import { docHandlers } from "./docs.ts";
import { outputHandlers } from "./outputs.ts";

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

/** Thread titles the project vocabulary reads, the most recently updated first. */
const VOCABULARY_TITLES = 200;

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
  // The Files panel reads this machine's folders; which paths a thread may read stays decided here.
  const hosts = yield* WorkerHosts;
  const hostFiles = hosts.placed.files;
  const nameOf = yield* machineNames;

  const threadOf = (threadId: ThreadId) =>
    store
      .getThread(threadId)
      .pipe(
        Effect.catchTag("ThreadNotFound", () =>
          Effect.fail(new InvalidState({ message: "This thread no longer exists", threadId })),
        ),
      );
  const vocabulary = makeVocabularyCache();
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
  /** `gate` for `path` in `threadId`, as `previewTarget` asks it. */
  const gateFor = (threadId: ThreadId, path: string, gate: Gate): OutsideGate => ({
    allows: gate.allows(threadId, path),
    refusal: gate.refusal,
  });
  /**
   * Reads `path` for a preview in `threadId` with `read`, where `previewTarget` allows it; outside
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
  ) => readPreview(path, roots, gateFor(threadId, path, gate), read);

  /**
   * The machine a thread's files are on when it isn't this one: its host, for the reads that are
   * done there, and its name. `undefined` for a thread on this machine. Nothing about the thread's
   * paths is looked up on this disk once it is on another machine.
   */
  const machineOf = (thread: Thread) =>
    Effect.gen(function* () {
      const checkout = effectiveCheckout(thread);
      if (isLocalHost(checkout)) return undefined;
      const name = nameOf(hostOf(checkout));
      const host = yield* hosts.get(hostOf(checkout)).pipe(
        Effect.mapError(
          (error) =>
            new InvalidState({
              message: `This thread's files are on ${name}, which can't be reached now: ${error.message}`,
            }),
        ),
      );
      /** The machine's reads, or a refusal naming it for a host too old to do them. */
      const reads: Effect.Effect<HostFileReads, InvalidState> =
        host.reads === undefined
          ? Effect.fail(
              new InvalidState({
                message: `gram-host on ${name} is older than this Gram, so its files can't be read from here. Update it (Settings → Machines, or rerun its install command there).`,
              }),
            )
          : Effect.succeed(host.reads);
      return { name, files: host.files, reads };
    });
  /**
   * Whether the thread's transcript lets a preview on its machine read `path` outside `roots`,
   * asked only when `path` could be outside them (`mayBeOutside`), since the host decides the rest.
   */
  const outsideOn = (
    threadId: ThreadId,
    path: string,
    roots: ReadonlyArray<string>,
    gate: Gate = inMessages,
  ): Effect.Effect<OutsideAllowed> =>
    mayBeOutside(path, roots)
      ? Effect.map(gate.allows(threadId, path), (allowed) => ({ allowed, refusal: gate.refusal }))
      : Effect.succeed({ allowed: false, refusal: gate.refusal });
  /** The thread's folder on its machine, `path` scoped to it there; for list, search and names. */
  const scopedOn = (
    machine: NonNullable<Effect.Success<ReturnType<typeof machineOf>>>,
    path: string,
    thread: Thread,
  ) =>
    Effect.flatMap(machine.reads, (reads) => reads.scope(path, [effectiveCheckout(thread).path]));

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
        const options = { showHidden: showHidden ?? false, limit: limit ?? LIST_LIMIT };
        const thread = threadId === undefined ? undefined : yield* threadOf(threadId);
        const machine = thread === undefined ? undefined : yield* machineOf(thread);
        if (machine !== undefined && thread !== undefined) {
          return yield* machine.files.list(yield* scopedOn(machine, path, thread), options);
        }
        const target = yield* resolveScoped(path, yield* scopeRoot(threadId));
        return yield* hostFiles.list(target, options);
      }),

    "fs.file": ({ path, threadId, maxBytes }) =>
      Effect.gen(function* () {
        if (threadId === undefined) return yield* noThread();
        const limit = Math.min(maxBytes ?? FILE_MAX_BYTES, FILE_MAX_BYTES_CEILING);
        const thread = yield* threadOf(threadId);
        // A worker spanning repos has files in its other worktrees too, which a file link opens.
        const roots = checkoutRoots(thread);
        const machine = yield* machineOf(thread);
        if (machine !== undefined) {
          const reads = yield* machine.reads;
          return yield* reads.file(path, roots, yield* outsideOn(threadId, path, roots), limit);
        }
        return yield* preview(path, threadId, roots, (target, opened) =>
          readFilePreview(target, limit, opened),
        );
      }),

    "fs.search": ({ threadId, query, regex, caseSensitive, offset, limit }) =>
      Effect.gen(function* () {
        const options = {
          regex: regex ?? false,
          caseSensitive: caseSensitive ?? false,
          offset: offset ?? 0,
          limit: Math.min(limit ?? SEARCH_PAGE, SEARCH_MAX_PAGE),
        };
        const thread = threadId === undefined ? undefined : yield* threadOf(threadId);
        const machine = thread === undefined ? undefined : yield* machineOf(thread);
        if (machine !== undefined && thread !== undefined) {
          return yield* machine.files.search(yield* scopedOn(machine, ".", thread), query, options);
        }
        const checkout = yield* scopeRoot(threadId);
        const root = yield* resolveScoped(".", checkout);
        return yield* hostFiles.search(root, query, options);
      }),

    "fs.files": ({ threadId, path }) =>
      Effect.gen(function* () {
        const thread = threadId === undefined ? undefined : yield* threadOf(threadId);
        const machine = thread === undefined ? undefined : yield* machineOf(thread);
        if (machine !== undefined && thread !== undefined) {
          return yield* machine.files.names(yield* scopedOn(machine, path ?? ".", thread));
        }
        const root = yield* resolveScoped(path ?? ".", yield* scopeRoot(threadId));
        return yield* hostFiles.names(root);
      }),

    "fs.vocabulary": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* threadOf(threadId);
        const checkout = effectiveCheckout(thread);
        // The project's recent threads name what is being worked on; their titles cost no git.
        const titles = (yield* store.listThreads)
          .filter((other) => other.projectId === thread.projectId)
          .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
          .slice(0, VOCABULARY_TITLES)
          .map((other) => other.title);
        const machine = yield* machineOf(thread).pipe(Effect.orElseSucceed(() => null));
        if (machine !== undefined) {
          // Read where the checkout is; offline, or on a host too old to read it, the titles stay.
          const sources =
            machine === null
              ? undefined
              : yield* machine.reads.pipe(
                  Effect.flatMap((reads) => reads.vocabulary(checkout.path)),
                  Effect.orElseSucceed(() => undefined),
                );
          return projectTerms({ symbols: [], files: [], branches: [], ...sources, titles });
        }
        return yield* vocabulary(checkout.path, titles).pipe(Effect.provideService(Proc, proc));
      }),

    "fs.resolve": ({ threadId, paths }) =>
      Effect.gen(function* () {
        const thread = yield* threadOf(threadId);
        const roots = checkoutRoots(thread);
        const machine = yield* machineOf(thread);
        if (machine !== undefined) {
          // The host resolves what is in the thread's folders; a path outside them is asked about
          // here, in the transcript, and then checked there.
          const reads = yield* machine.reads;
          const first = yield* reads.resolve(paths, roots, []);
          const vouched = yield* Effect.filter(
            first.unchecked,
            (path) => mentioned(threadId, path),
            {
              concurrency: 8,
            },
          );
          if (vouched.length === 0) return { files: [...first.files] };
          const outside = yield* reads.resolve(vouched, roots, vouched);
          return { files: [...first.files, ...outside.files] };
        }
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
        const machine = yield* machineOf(thread);
        if (machine !== undefined && kind === "html") {
          // Its page loads the files beside it from a listener on this machine, which can't reach them.
          return yield* new InvalidState({
            message: `Gram can't preview HTML from ${machine.name} yet. Open ${path} in the Files panel to read its source.`,
          });
        }
        if (machine !== undefined) {
          const reads = yield* machine.reads;
          const file = yield* reads.file(
            path,
            roots,
            yield* outsideOn(threadId, path, roots, writtenByThread),
            FILE_MAX_BYTES,
          );
          if (file.content === undefined) {
            return yield* new InvalidState({
              message: file.binary ? `${path} isn't text` : `${path} is too large to preview`,
            });
          }
          return { kind: "markdown", path: file.path, content: file.content } as const;
        }
        if (kind === "html") {
          if (previewFiles === undefined) {
            return yield* new InvalidState({ message: "HTML previews aren't available here" });
          }
          // The listener opens each file it serves through `openOutside`, this page included.
          const { target, outside } = yield* previewTarget(
            path,
            roots,
            gateFor(threadId, path, writtenByThread),
          );
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
        const limit = Math.min(maxBytes ?? IMAGE_MAX_BYTES, IMAGE_MAX_BYTES);
        const machine = yield* machineOf(thread);
        if (machine !== undefined) {
          const reads = yield* machine.reads;
          return yield* reads.image(path, roots, yield* outsideOn(threadId, path, roots), limit);
        }
        return yield* preview(path, threadId, roots, (target, opened) =>
          readImage(target, limit, opened),
        );
      }),
  } satisfies Partial<Handlers>;
});

/**
 * The files group's handler layer: these, `editor.open` / `fs.reveal`, `workspace.outputs` and the
 * workspace docs (`docs.*`).
 */
export const FileHandlersLive = FileRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* fsHandlers),
      ...(yield* editorHandlers),
      ...(yield* outputHandlers),
      ...(yield* docHandlers),
    };
    return FileRpcs.of(logDefects(FileRpcs, handlers));
  }),
);
