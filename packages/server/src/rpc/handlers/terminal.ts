import { effectiveCheckout, TerminalRpcs } from "@gram/contracts";
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

  return {
    "terminal.open": (request) => terminals.open(request),
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
