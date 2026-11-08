import { effectiveCheckout } from "@gram/contracts";
import { PathProbe } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ProcessRoots } from "../ports/roots.ts";
import { TerminalGate } from "./gate.ts";
import { makeTerminals, type Terminals } from "./terminals.ts";

/**
 * This machine's pseudo-terminals, opened in its threads' checkouts, closed with their thread and
 * at shutdown. The local `WorkerHost` hands them out; the Terminal tab reaches them through it.
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
      return yield* makeTerminals({
        roots: yield* ProcessRoots,
        ...(gate === undefined ? {} : { held: gate.held }),
        threadFolder: (threadId) =>
          store.getThread(threadId).pipe(Effect.map((thread) => effectiveCheckout(thread).path)),
        defaultFolder: store.getSettings.pipe(
          Effect.map((settings) => settings.agents.defaultFolder),
        ),
        settingsShell: store.getSettings.pipe(Effect.map((settings) => settings.terminal.shell)),
        path: probe.path,
        closedThreads: hub
          .internalEvents(isThreadRemoved, "terminal cleanup")
          .pipe(Stream.map((event) => event.threadId)),
      });
    }),
  );
}
