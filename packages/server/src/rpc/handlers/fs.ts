import type { FileHandle } from "node:fs/promises";
import {
  checkoutRoots,
  effectiveCheckout,
  hostOf,
  isLocalHost,
  LOCAL_HOST_ID,
  previewFileKind,
  sessionHostOf,
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
  openForRead,
  type OutsideGate,
  previewTarget,
  readFilePreview,
  readPreview,
  resolveFileRefs,
  resolveScoped,
  writesPath,
} from "../../fs/files.ts";
import { browseFolders, expandHome } from "../../fs/folders.ts";
import {
  isSecretPath,
  realSecretPaths,
  refuseSecretHandle,
  refuseSecretPath,
} from "../../fs/secret-paths.ts";
import { ServerConfig } from "../../config.ts";
import { openerFenced } from "../../platform/opener.ts";
import { IMAGE_MAX_BYTES, readImage } from "../../fs/images.ts";
import { makeVocabularyCache, projectTerms } from "../../fs/vocabulary.ts";
import type { HostFileReads, OutsideAllowed } from "../../host/file-reads.ts";
import { machineNames } from "../../host/machine-name.ts";
import { SEARCH_MAX_PAGE, SEARCH_PAGE } from "../../fs/search.ts";
import { readableOnly } from "../../embedding/readable-by.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { filesWrittenBy, pageFolderCheck, PreviewFiles } from "../../preview/files.ts";
import { logDefects, type Handlers } from "./common.ts";
import { editorHandlers } from "./editor.ts";
import { docHandlers } from "./docs.ts";
import { outputHandlers } from "./outputs.ts";

const namedPathKey = (path: string) => {
  const resolved = resolve(expandHome(path.trim()));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const sameNamedPath = (written: string, target: string): boolean =>
  namedPathKey(written) === namedPathKey(target);

const VOCABULARY_TITLES = 200;

const noThread = () => new InvalidState({ message: "Open a file from a thread to preview it" });

/**
 * `fs.browse` for the project picker, `fs.tree` over it, `fs.list` / `fs.file` / `fs.search` for the
 * Files panel, `fs.resolve` for the transcript's file links, and `fs.image` for image previews.
 */
export const fsHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const proc = yield* Proc;
  const hosts = yield* WorkerHosts;
  const hostFiles = hosts.placed.files;
  const nameOf = yield* machineNames;
  const config = yield* ServerConfig;
  const secrets = config.secretPaths ?? [];
  const realSecrets = realSecretPaths(secrets);
  const transcriptVouches = (thread: Thread) =>
    !openerFenced(config) && sessionHostOf(thread) === LOCAL_HOST_ID;

  const threadOf = (threadId: ThreadId) =>
    store
      .getThread(threadId)
      .pipe(
        Effect.catchTag("ThreadNotFound", () =>
          Effect.fail(new InvalidState({ message: "This thread no longer exists", threadId })),
        ),
      );
  const vocabulary = makeVocabularyCache();
  const previewFiles = Option.getOrUndefined(yield* Effect.serviceOption(PreviewFiles));

  const scopeRoot = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(undefined)
      : threadOf(threadId).pipe(Effect.map((thread) => effectiveCheckout(thread).path));

  const mentioned = (threadId: ThreadId, path: string) =>
    Effect.gen(function* () {
      const forms = mentionForms(path);
      const texts = yield* store.messageTextsWith(threadId, [...forms, ...mentionHints(forms)]);
      return texts.some((text) => writesPath(text, forms));
    });
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
  const confined: Gate = {
    allows: () => Effect.succeed(false),
    refusal: "is outside this thread's folders",
  };
  const gateOf = (thread: Thread, gate: Gate): Gate =>
    transcriptVouches(thread) ? gate : confined;
  const gateFor = (threadId: ThreadId, path: string, gate: Gate): OutsideGate => ({
    allows: gate.allows(threadId, path),
    refusal: gate.refusal,
  });
  const preview = <A>(
    path: string,
    thread: Thread,
    roots: ReadonlyArray<string>,
    read: (target: string, opened?: FileHandle) => Effect.Effect<A, NotFound | InvalidState>,
    gate: Gate = inMessages,
  ) =>
    readPreview(path, roots, gateFor(thread.id, path, gateOf(thread, gate)), (target, opened) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = opened ?? (yield* openForRead(target));
          yield* refuseSecretHandle(handle, target, realSecrets);
          return yield* read(target, handle);
        }),
      ),
    );

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
  const outsideOn = (
    threadId: ThreadId,
    path: string,
    roots: ReadonlyArray<string>,
    gate: Gate = inMessages,
  ): Effect.Effect<OutsideAllowed> =>
    mayBeOutside(path, roots)
      ? Effect.map(gate.allows(threadId, path), (allowed) => ({ allowed, refusal: gate.refusal }))
      : Effect.succeed({ allowed: false, refusal: gate.refusal });
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
        const roots = checkoutRoots(thread);
        const machine = yield* machineOf(thread);
        if (machine !== undefined) {
          const reads = yield* machine.reads;
          return yield* reads.file(path, roots, yield* outsideOn(threadId, path, roots), limit);
        }
        return yield* preview(path, thread, roots, (target, opened) =>
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
        const titles = (yield* readableOnly(yield* store.listThreads, (other) => other))
          .filter((other) => other.projectId === thread.projectId)
          .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
          .slice(0, VOCABULARY_TITLES)
          .map((other) => other.title);
        const machine = yield* machineOf(thread).pipe(Effect.orElseSucceed(() => null));
        if (machine !== undefined) {
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
        const vouches = transcriptVouches(thread);
        const files = yield* resolveFileRefs(paths, roots, (path) =>
          vouches ? mentioned(threadId, path) : Effect.succeed(false),
        ).pipe(Effect.provideService(Proc, proc));
        const readable = yield* Effect.filter(files, (file) =>
          Effect.map(isSecretPath(file.resolved, secrets), (secret) => !secret),
        );
        return { files: readable };
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
          const { target, outside } = yield* previewTarget(
            path,
            roots,
            gateFor(threadId, path, gateOf(thread, writtenByThread)),
          );
          const real = yield* pageFolderCheck(target, outside, roots);
          yield* refuseSecretPath(real, secrets);
          return { kind, path: target, url: yield* previewFiles.urlFor(real) } as const;
        }
        const file = yield* preview(
          path,
          thread,
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
        if (threadId === undefined) return yield* noThread();
        const thread = yield* threadOf(threadId);
        const roots = [...new Set([thread.checkout.path, ...checkoutRoots(thread)])];
        const limit = Math.min(maxBytes ?? IMAGE_MAX_BYTES, IMAGE_MAX_BYTES);
        const machine = yield* machineOf(thread);
        if (machine !== undefined) {
          const reads = yield* machine.reads;
          return yield* reads.image(path, roots, yield* outsideOn(threadId, path, roots), limit);
        }
        return yield* preview(path, thread, roots, (target, opened) =>
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
