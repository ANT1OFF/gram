import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { checkoutRoots, InvalidState, NotFound, type ThreadId } from "@gram/contracts";
import { childEnv, PathProbe } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { refuseUnavailable } from "../../config.ts";
import { editorCommand, resolveEditorBin, revealCommand } from "../../editor/editor.ts";
import { resolveScoped, resolveScopedIn } from "../../fs/files.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { Opener } from "../../platform/opener.ts";
import type { Handlers } from "./common.ts";

/**
 * `editor.open`: a file (at a line) or folder in `settings.editor.command`. `fs.reveal`: the same
 * target shown in Finder / Explorer. Both spawn detached on the local machine.
 */
export const editorHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const launcher = yield* Opener;
  const probe = yield* Effect.serviceOption(PathProbe);
  const childPath = Option.isSome(probe)
    ? probe.value.path
    : Effect.sync(() => process.env["PATH"] ?? "");

  /** A relative path is the checkout's; an absolute one may be in any folder of the thread's. */
  const scopeRoots = (threadId: ThreadId) =>
    store.getThread(threadId).pipe(
      Effect.map((thread) => [...new Set([thread.checkout.path, ...checkoutRoots(thread)])]),
      Effect.catchTag("ThreadNotFound", () =>
        Effect.fail(new InvalidState({ message: "This thread no longer exists", threadId })),
      ),
    );

  const resolveTarget = (path: string, threadId: ThreadId | undefined) =>
    Effect.gen(function* () {
      const target =
        threadId === undefined
          ? yield* resolveScoped(path, undefined)
          : yield* resolveScopedIn(path, yield* scopeRoots(threadId));
      const info = yield* Effect.tryPromise({
        try: () => stat(target),
        catch: () => new NotFound({ entity: "file", id: target, message: `Not found: ${target}` }),
      });
      return { target, folder: info.isDirectory() };
    });

  return {
    "editor.open": ({ path, line, threadId }) =>
      Effect.gen(function* () {
        yield* refuseUnavailable("openInEditor");
        const { target, folder } = yield* resolveTarget(path, threadId);
        const settings = yield* store.getSettings;
        const command = editorCommand(settings.editor.command, { path: target, line, folder });
        const pathValue = yield* childPath;
        const bin = resolveEditorBin(command.bin, process.platform, pathValue);
        yield* launcher.launch({
          ...bin,
          args: command.args,
          cwd: folder ? target : dirname(target),
          env: childEnv(process.env, pathValue, process.platform),
        });
        return { editor: command.name };
      }),
    "fs.reveal": ({ path, threadId }) =>
      Effect.gen(function* () {
        yield* refuseUnavailable("revealInFileManager");
        const { target, folder } = yield* resolveTarget(path, threadId);
        const command = revealCommand(target, folder, process.platform);
        const pathValue = yield* childPath;
        yield* launcher.launch({
          file: command.bin,
          shell: false,
          verbatim: command.verbatim,
          window: true,
          args: command.args,
          cwd: folder ? target : dirname(target),
          env: childEnv(process.env, pathValue, process.platform),
        });
        return { manager: command.name };
      }),
  } satisfies Partial<Handlers>;
});
