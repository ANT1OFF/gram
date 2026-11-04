import {
  effectiveCheckout,
  InvalidState,
  NotFound,
  TerminalRpcs,
  type ThreadId,
} from "@gram/contracts";
import { PathProbe } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AppToolRegistry } from "../../app-tools/registry.ts";
import { readTerminalTool } from "../../app-tools/terminal-tools.ts";
import { EventHub, isThreadRemoved } from "../../events/event-hub.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ProcessRoots } from "../../ports/service.ts";
import { TerminalGate } from "../../terminal/gate.ts";
import { resolveScriptRun, ScriptsError } from "../../scripts/project-scripts.ts";
import { makeTerminals } from "../../terminal/terminals.ts";
import { checkShell } from "../../terminal/shell-check.ts";
import { logDefects, type Handlers } from "./common.ts";

/** `terminal.*`: pseudo-terminals for the Terminal tab, closed with their thread and at shutdown. */
const terminalHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const probe = yield* PathProbe;
  const roots = yield* ProcessRoots;
  // Absent in test layers without closes only at rest.
  const gate = Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate));

  const terminals = yield* makeTerminals({
    roots,
    ...(gate === undefined ? {} : { held: gate.held }),
    threadFolder: (threadId) =>
      store.getThread(threadId).pipe(Effect.map((thread) => effectiveCheckout(thread).path)),
    defaultFolder: store.getSettings.pipe(Effect.map((settings) => settings.agents.defaultFolder)),
    settingsShell: store.getSettings.pipe(Effect.map((settings) => settings.terminal.shell)),
    path: probe.path,
    closedThreads: hub
      .internalEvents(isThreadRemoved, "terminal cleanup")
      .pipe(Stream.map((event) => event.threadId)),
  });

  // The terminals live here rather than in a core service, so their tool registers from here too.
  yield* (yield* AppToolRegistry).register([readTerminalTool(terminals)]);

  /** A project script's command and folder, read from the project's own scripts file now. */
  const scriptRun = (threadId: ThreadId, name: string) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const project = (yield* store.listProjects).find((each) => each.id === thread.projectId);
      if (project === undefined)
        return yield* new NotFound({ entity: "project", id: thread.projectId });
      return yield* Effect.tryPromise({
        try: () => resolveScriptRun(project.root, effectiveCheckout(thread).path, name),
        catch: (error) =>
          new InvalidState({
            message: error instanceof ScriptsError ? error.message : `Can't run ${name}.`,
          }),
      });
    });

  return {
    "terminal.open": ({ script, ...request }) =>
      script === undefined
        ? terminals.open(request)
        : Effect.gen(function* () {
            if (request.threadId === undefined)
              return yield* new InvalidState({ message: "A script runs in a thread's checkout." });
            if (request.cwd !== undefined)
              return yield* new InvalidState({ message: "A script runs in its own folder." });
            const run = yield* scriptRun(request.threadId, script);
            return yield* terminals.open({
              ...request,
              cwd: run.cwd,
              command: run.command,
              script: run.name,
            });
          }),
    "terminal.input": ({ terminalId, data }) => terminals.input(terminalId, data),
    "terminal.resize": ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows),
    "terminal.close": ({ terminalId }) => terminals.close(terminalId),
    "terminal.list": ({ threadId }) => terminals.list(threadId),
    "terminal.subscribe": ({ terminalId }) => terminals.subscribe(terminalId),
    "terminal.checkShell": ({ shell }) =>
      Effect.succeed(checkShell(shell, process.platform, process.env["PATH"] ?? "")),
  } satisfies Partial<Handlers>;
});

/** The `terminal.*` group's handler layer. */
export const TerminalHandlersLive = TerminalRpcs.toLayer(
  Effect.map(terminalHandlers, (handlers) => TerminalRpcs.of(logDefects(TerminalRpcs, handlers))),
);
