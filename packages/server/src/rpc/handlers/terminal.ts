import {
  effectiveCheckout,
  InvalidState,
  NotFound,
  TerminalRpcs,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
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
import { checkShell } from "../../terminal/shell-check.ts";
import { openSignInTerminal } from "../../host/claude-sign-in.ts";
import { logDefects, type Handlers } from "./common.ts";

/** `terminal.*`: the Terminal tab, over the host's pseudo-terminals. */
const terminalHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  // This machine's terminals; a thread on another machine will reach that machine's instead.
  const workerHosts = yield* WorkerHosts;
  const { terminals } = workerHosts.placed;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));

  // The agent tool that reads a terminal registers with the handlers, as it always has.
  yield* (yield* AppToolRegistry).register([readTerminalTool(terminals)]);

  /** A project script's command and folder, read from the project's own scripts file now. */
  const scriptRun = (threadId: ThreadId, name: string) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const project = (yield* store.listProjects).find((each) => each.id === thread.projectId);
      if (project === undefined)
        return yield* new NotFound({ entity: "project", id: thread.projectId });
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
        ? openSignInTerminal(terminals, workerHosts.get, signIn, { ...request, script })
        : script === undefined
          ? terminals.open(request)
          : Effect.gen(function* () {
              if (request.threadId === undefined)
                return yield* new InvalidState({
                  message: "A script runs in a thread's checkout.",
                });
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
