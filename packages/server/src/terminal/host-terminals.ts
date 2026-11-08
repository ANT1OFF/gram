import { homedir } from "node:os";
import { effectiveCheckout, InvalidState, type TerminalId, type ThreadId } from "@gram/contracts";
import { PathProbe } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { LocalHostProcess } from "../host/local-process.ts";
import type { HostTerminalsConnection } from "../host/protocol.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ProcessRoots } from "../ports/roots.ts";
import { TerminalGate } from "./gate.ts";
import { HELD, makeTerminals, type Terminals, type TerminalsDeps } from "./terminals.ts";

/**
 * Terminals opened in the host process, the rest in the server. The server keeps what the host
 * has none of: it chooses each terminal's folder, reads the settings it opens with, holds a
 * closing thread's terminals, closes them with their thread, and counts the host's shells among
 * their threads' processes for the port chips. A host that has gone took its shells with it, and
 * new terminals open in the server.
 */
export const terminalsThroughHost = (
  host: HostTerminalsConnection,
  gone: () => boolean,
  inServer: Terminals,
  deps: Omit<TerminalsDeps, "closedThreads"> & {
    readonly closedThreads: Stream.Stream<ThreadId>;
  },
) =>
  Effect.gen(function* () {
    /** The terminals the host holds, with the thread each was opened for. */
    const onHost = new Map<TerminalId, ThreadId | undefined>();
    /** The host's shells counted among the server's process roots. */
    const counted = new Set<number>();
    const uncountAll = Effect.sync(() => {
      for (const pid of counted) deps.roots?.remove(pid);
      counted.clear();
    });
    yield* host.roots.pipe(
      Stream.runForEach((root) =>
        Effect.sync(() => {
          if (root.kind === "add") {
            counted.add(root.pid);
            deps.roots?.add(root.threadId, root.pid, root.terminalId);
          } else {
            counted.delete(root.pid);
            deps.roots?.remove(root.pid);
          }
        }),
      ),
      Effect.ignore,
      // The host's shells end with it, and their ids with them.
      Effect.ensuring(
        Effect.andThen(
          uncountAll,
          Effect.sync(() => onHost.clear()),
        ),
      ),
      Effect.forkScoped,
    );
    /** Threads closed while this server runs, so a terminal opening as one closes is closed too. */
    const closedIds = new Set<ThreadId>();
    yield* deps.closedThreads.pipe(
      Stream.tap((threadId) => Effect.sync(() => closedIds.add(threadId))),
      Stream.runForEach((threadId) =>
        host
          .list(threadId)
          .pipe(
            Effect.flatMap((open) =>
              Effect.forEach(
                open,
                (terminal) =>
                  host
                    .close(terminal.terminalId)
                    .pipe(
                      Effect.ignore,
                      Effect.andThen(Effect.sync(() => onHost.delete(terminal.terminalId))),
                    ),
                { concurrency: "unbounded", discard: true },
              ),
            ),
          ),
      ),
      Effect.forkScoped,
    );

    const held = (threadId: ThreadId | undefined) =>
      threadId !== undefined && deps.held?.(threadId) === true;
    const isOnHost = (terminalId: TerminalId) => onHost.has(terminalId);

    const open: Terminals["open"] = (request, settings) =>
      Effect.suspend(() => {
        if (gone()) return inServer.open(request, settings);
        return Effect.gen(function* () {
          const threadFolder =
            request.threadId === undefined ? undefined : yield* deps.threadFolder(request.threadId);
          const cwd = request.cwd ?? threadFolder ?? (yield* deps.defaultFolder) ?? homedir();
          const resolved = settings ?? {
            settingsShell: yield* deps.settingsShell,
            path: yield* deps.path,
          };
          // Checked last, as the server's own terminals do, so a hold taken meanwhile counts.
          if (held(request.threadId)) return yield* new InvalidState({ message: HELD });
          const opened = yield* host.open({ ...request, cwd }, resolved);
          onHost.set(opened.terminalId, request.threadId);
          // The open crossed to the host and back, so a hold taken or a close made meanwhile
          // didn't see this shell: it is closed again here, as the server's own spawn never lets
          // one through.
          const threadId = request.threadId;
          if (threadId !== undefined && (held(threadId) || closedIds.has(threadId))) {
            yield* host.close(opened.terminalId).pipe(Effect.ignore);
            onHost.delete(opened.terminalId);
            return yield* new InvalidState({ message: HELD });
          }
          return opened;
        });
      });

    return {
      open,
      input: (terminalId, data) =>
        Effect.suspend(() => {
          if (!isOnHost(terminalId)) return inServer.input(terminalId, data);
          return held(onHost.get(terminalId))
            ? Effect.fail(new InvalidState({ message: HELD }))
            : host.input(terminalId, data);
        }),
      resize: (terminalId, cols, rows) =>
        Effect.suspend(() =>
          isOnHost(terminalId)
            ? host.resize(terminalId, cols, rows)
            : inServer.resize(terminalId, cols, rows),
        ),
      close: (terminalId) =>
        Effect.suspend(() =>
          isOnHost(terminalId)
            ? host
                .close(terminalId)
                .pipe(Effect.ensuring(Effect.sync(() => onHost.delete(terminalId))))
            : inServer.close(terminalId),
        ),
      list: (threadId) =>
        Effect.zipWith(host.list(threadId), inServer.list(threadId), (a, b) => [...a, ...b]),
      subscribe: (terminalId) =>
        Stream.suspend(() =>
          isOnHost(terminalId) ? host.subscribe(terminalId) : inServer.subscribe(terminalId),
        ),
      snapshot: (threadId) =>
        Effect.zipWith(host.snapshot(threadId), inServer.snapshot(threadId), (a, b) => [
          ...a,
          ...b,
        ]),
    } satisfies Terminals;
  });

/**
 * This machine's pseudo-terminals, opened in its threads' checkouts, closed with their thread and
 * at shutdown. The local `WorkerHost` hands them out; the Terminal tab reaches them through it.
 * With the host process on (`LocalHostProcess`), new ones open there.
 */
export class HostTerminals extends Context.Service<HostTerminals, Terminals>()(
  "@gram/server/HostTerminals",
) {
  static readonly layer: Layer.Layer<
    HostTerminals,
    never,
    ThreadStore | EventHub | PathProbe | ProcessRoots
  > = Layer.effect(
    HostTerminals,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const probe = yield* PathProbe;
      // Absent in test layers without closes only at rest.
      const gate = Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate));
      const closedThreads = (label: string) =>
        hub.internalEvents(isThreadRemoved, label).pipe(Stream.map((event) => event.threadId));
      const deps = {
        roots: yield* ProcessRoots,
        ...(gate === undefined ? {} : { held: gate.held }),
        threadFolder: (threadId: ThreadId) =>
          store.getThread(threadId).pipe(Effect.map((thread) => effectiveCheckout(thread).path)),
        defaultFolder: store.getSettings.pipe(
          Effect.map((settings) => settings.agents.defaultFolder),
        ),
        settingsShell: store.getSettings.pipe(Effect.map((settings) => settings.terminal.shell)),
        path: probe.path,
      };
      const inServer = yield* makeTerminals({
        ...deps,
        closedThreads: closedThreads("terminal cleanup"),
      });
      // Absent in test layers that run no host process.
      const local = Option.getOrUndefined(yield* Effect.serviceOption(LocalHostProcess));
      const connection = local?.connection;
      if (connection === undefined) return inServer;
      return yield* terminalsThroughHost(connection.terminals, connection.gone, inServer, {
        ...deps,
        closedThreads: closedThreads("host terminal cleanup"),
      });
    }),
  );
}
