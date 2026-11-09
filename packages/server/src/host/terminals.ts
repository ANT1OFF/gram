import { homedir } from "node:os";
import type { TerminalId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeTerminals, type Terminals } from "../terminal/terminals.ts";

/** A thread's shell starting or ending, for the control plane's process roots. */
export type TerminalRoot =
  | {
      readonly kind: "add";
      readonly threadId: ThreadId;
      readonly pid: number;
      readonly terminalId: TerminalId;
    }
  | { readonly kind: "remove"; readonly pid: number };

/** A machine's pseudo-terminals as its host serves them, and its threads' shells as they come and go. */
export interface HostTerminalsService {
  readonly terminals: Terminals;
  /** The shells running now, then each one that starts or ends. */
  readonly roots: Stream.Stream<TerminalRoot>;
  /** The pids of the threads' shells running now. */
  readonly shells: () => ReadonlyArray<number>;
}

/**
 * The host's own terminals. The control plane chooses every terminal's folder and reads the
 * settings it opens with, and closes a thread's terminals when the thread closes: the host has no
 * threads or settings of its own. Every terminal is killed when the scope closes.
 */
export const terminalsOnHost: Effect.Effect<HostTerminalsService, never, Scope.Scope> = Effect.gen(
  function* () {
    const changes = yield* PubSub.unbounded<TerminalRoot>();
    const live = new Map<number, Extract<TerminalRoot, { kind: "add" }>>();
    const terminals = yield* makeTerminals({
      // Never reached for a folder: every open names its `cwd`.
      threadFolder: () => Effect.succeed(homedir()),
      defaultFolder: Effect.succeed(undefined),
      settingsShell: Effect.succeed(undefined),
      path: Effect.sync(() => process.env["PATH"] ?? ""),
      closedThreads: Stream.never,
      roots: {
        add: (threadId, pid, terminalId) => {
          const root = { kind: "add", threadId, pid, terminalId } as const;
          live.set(pid, root);
          PubSub.publishUnsafe(changes, root);
        },
        remove: (pid) => {
          live.delete(pid);
          PubSub.publishUnsafe(changes, { kind: "remove", pid });
        },
      },
    });
    const roots = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the shells running now are read, so none starts or ends unseen.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromIterable([...live.values()]),
          Stream.fromSubscription(subscription),
        );
      }),
    );
    return { terminals, roots, shells: () => [...live.keys()] };
  },
);
