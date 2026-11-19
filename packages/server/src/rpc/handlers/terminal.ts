import {
  effectiveCheckout,
  hostOf,
  InvalidState,
  NotFound,
  type TerminalId,
  type TerminalInfo,
  TerminalRpcs,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  anyPrivate,
  currentReader,
  machineHoldsUnreadable,
  machineKey,
  onPrivatePlaced,
  NOT_READABLE,
  type Reader,
  readableByOf,
  readerMay,
  touchesUnreadable,
} from "../../embedding/readable-by.ts";
import { FrontedSignIn } from "../actor-guard.ts";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { AppToolRegistry } from "../../app-tools/registry.ts";
import { readTerminalTool } from "../../app-tools/terminal-tools.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import {
  projectScriptsDir,
  resolveScriptRun,
  ScriptsError,
} from "../../scripts/project-scripts.ts";
import { folderBringsNothing, projectFolderTrusted } from "../../settings/folder-trust.ts";
import { checkShell } from "../../terminal/shell-check.ts";
import { openSignInTerminal } from "../../host/claude-sign-in.ts";
import { logDefects, type Handlers } from "./common.ts";

/**
 * What a person is told who would open a shell on a machine that holds a thread they may not see,
 * behind a proxy (`embedding/readable-by.ts`).
 */
export const SHARED_MACHINE =
  "This machine holds a thread readable by someone else, so no shell opens on it for you.";

/** Why a script from a folder the user hasn't trusted doesn't run. */
export const UNTRUSTED_SCRIPTS = "Trust this folder to run its scripts.";

/** `terminal.*`: the Terminal tab, over the host's pseudo-terminals. */
const terminalHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  // This machine's terminals; a thread on another machine will reach that machine's instead.
  const workerHosts = yield* WorkerHosts;
  const { terminals } = workerHosts.placed;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));

  // The agent tool that reads a terminal registers with the handlers, as it always has.
  yield* (yield* AppToolRegistry).register([readTerminalTool(terminals)]);

  // Whether people sign in through a proxy. Absent in test layers with no actor guard.
  const fronted = Option.getOrUndefined(yield* Effect.serviceOption(FrontedSignIn));

  /**
   * Who opened each terminal that is no thread's, by their subject (`undefined` for no one): its
   * shell, its output and its keystrokes are theirs alone once any thread is readable by one person.
   */
  const openedBy = new Map<string, string | undefined>();
  /** The machine each terminal opened since the server started runs on (`undefined`: this one). */
  const openedOn = new Map<string, string | undefined>();

  /**
   * Once a thread readable by one person is placed on a machine, behind a proxy, the shells
   * already open there for anyone else close: a shell reads that thread's folder whatever opened
   * it. On this machine, which holds the database, every shell closes; a terminal whose machine
   * isn't known (one kept from before the server started) is taken to be on this one.
   */
  const placements = yield* Queue.unbounded<{ reader: string; machine: string | undefined }>();
  const stopListening = onPrivatePlaced((reader, machine) =>
    Queue.offerUnsafe(placements, { reader, machine }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(stopListening));
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const { reader, machine } = yield* Queue.take(placements);
        if (fronted === undefined || !(yield* fronted.active)) return;
        for (const info of yield* terminals.list(undefined)) {
          const on = openedOn.has(info.terminalId) ? openedOn.get(info.terminalId) : undefined;
          const theirs =
            info.threadId !== undefined
              ? readableByOf(info.threadId) === reader
              : openedBy.get(info.terminalId) === reader;
          if (on === undefined || (on === machine && !theirs))
            yield* terminals.close(info.terminalId).pipe(
              Effect.tap(() =>
                Effect.logInfo("closed a shell on a machine a private thread was placed on").pipe(
                  Effect.annotateLogs({ terminalId: info.terminalId }),
                ),
              ),
              Effect.ignore,
            );
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("closing shells failed", cause))),
    ),
  );

  /**
   * Whether `reader` may see a terminal (`embedding/readable-by.ts`): a thread's when it may see
   * that thread, one that is no thread's when it opened it, and neither when it runs in a folder
   * of a thread it may not see. A terminal that is no thread's and whose opener isn't known (one
   * opened before this server started) is judged by its folder alone.
   */
  const mayUse = (reader: Reader | undefined, info: TerminalInfo): boolean => {
    if (!anyPrivate() || reader === undefined) return true;
    if (touchesUnreadable(reader, [info.cwd])) return false;
    if (info.threadId !== undefined) return readerMay(reader, readableByOf(info.threadId));
    return !openedBy.has(info.terminalId) || openedBy.get(info.terminalId) === reader.subject;
  };

  /** `effect` refused when the caller may not use the terminal (`mayUse`). */
  const ofReadable = <A, E, R>(terminalId: TerminalId, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (anyPrivate()) {
        const info = (yield* terminals.list(undefined)).find((t) => t.terminalId === terminalId);
        if (info !== undefined && !mayUse(yield* currentReader, info))
          return yield* Effect.die(new Error(NOT_READABLE));
      }
      return yield* effect;
    });

  /**
   * Refused, behind a proxy, where a shell would run on a machine that holds a thread the caller
   * may not see: a shell there reads that thread's folder and this server's own files whatever the
   * API refuses. Otherwise the terminal, once open, is noted as the caller's when it is no thread's.
   */
  const opened = <A extends { readonly terminalId: TerminalId }, E, R>(
    hostId: string | undefined,
    threadless: boolean,
    open: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const reader = yield* currentReader;
      // This server's own machine holds its database, every transcript a private thread's
      // included, wherever that thread's checkouts are: no one gets a shell here behind a proxy.
      if (
        anyPrivate() &&
        fronted !== undefined &&
        (yield* fronted.active) &&
        (machineKey(hostId) === undefined || machineHoldsUnreadable(reader, hostId))
      )
        return yield* new InvalidState({ message: SHARED_MACHINE });
      const made = yield* open;
      if (threadless) openedBy.set(made.terminalId, reader?.subject);
      openedOn.set(made.terminalId, machineKey(hostId));
      return made;
    });
  const hostOfThread = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(undefined)
      : store.getThread(threadId).pipe(
          Effect.map((thread) => hostOf(effectiveCheckout(thread)) as string | undefined),
          Effect.orElseSucceed(() => undefined),
        );

  /** A project script's command and folder, read from the project's own scripts file now. */
  const scriptRun = (threadId: ThreadId, name: string) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const project = (yield* store.listProjects).find((each) => each.id === thread.projectId);
      if (project === undefined)
        return yield* new NotFound({ entity: "project", id: thread.projectId });
      // A folder's own scripts run only once the user trusts the folder they came with.
      if (!projectFolderTrusted(project, folderBringsNothing(project.root)))
        return yield* new InvalidState({ message: UNTRUSTED_SCRIPTS });
      return yield* Effect.tryPromise({
        try: () =>
          resolveScriptRun(
            project.root,
            effectiveCheckout(thread).path,
            name,
            config === undefined
              ? undefined
              : { dir: projectScriptsDir(config.dataDir), projectId: project.id },
          ),
        catch: (error) =>
          new InvalidState({
            message: error instanceof ScriptsError ? error.message : `Can't run ${name}.`,
          }),
      });
    });

  return {
    "terminal.open": ({ script, signIn, ...request }) =>
      signIn !== undefined
        ? opened(
            signIn,
            true,
            openSignInTerminal(terminals, workerHosts.get, signIn, { ...request, script }),
          )
        : script === undefined
          ? Effect.flatMap(hostOfThread(request.threadId), (hostId) =>
              opened(hostId, request.threadId === undefined, terminals.open(request)),
            )
          : Effect.gen(function* () {
              if (request.threadId === undefined)
                return yield* new InvalidState({
                  message: "A script runs in a thread's checkout.",
                });
              if (request.cwd !== undefined)
                return yield* new InvalidState({ message: "A script runs in its own folder." });
              const run = yield* scriptRun(request.threadId, script);
              return yield* opened(
                yield* hostOfThread(request.threadId),
                false,
                terminals.open({
                  ...request,
                  cwd: run.cwd,
                  command: run.command,
                  script: run.name,
                }),
              );
            }),
    "terminal.input": ({ terminalId, data }) =>
      ofReadable(terminalId, terminals.input(terminalId, data)),
    "terminal.resize": ({ terminalId, cols, rows }) =>
      ofReadable(terminalId, terminals.resize(terminalId, cols, rows)),
    "terminal.close": ({ terminalId }) => ofReadable(terminalId, terminals.close(terminalId)),
    "terminal.list": ({ threadId }) =>
      Effect.gen(function* () {
        const all = yield* terminals.list(threadId);
        const reader = yield* currentReader;
        return all.filter((info) => mayUse(reader, info));
      }),
    "terminal.subscribe": ({ terminalId }) =>
      Stream.unwrap(ofReadable(terminalId, Effect.succeed(terminals.subscribe(terminalId)))),
    "terminal.checkShell": ({ shell }) =>
      Effect.succeed(checkShell(shell, process.platform, process.env["PATH"] ?? "")),
  } satisfies Partial<Handlers>;
});

/** The `terminal.*` group's handler layer. */
export const TerminalHandlersLive = TerminalRpcs.toLayer(
  Effect.map(terminalHandlers, (handlers) => TerminalRpcs.of(logDefects(TerminalRpcs, handlers))),
);
