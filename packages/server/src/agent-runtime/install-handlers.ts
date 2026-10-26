import { codexRuntimeOf, NotImplemented, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ManagedRuntimes } from "./service.ts";

const missing = (rpc: string) => Effect.fail(new NotImplemented({ rpc }));

/**
 * `agentRuntime.{installState,watchInstall,install,cancel,rollback,useSource}`, and the hooks that
 * connect the managed store to settings and sessions. Without `ManagedRuntimes` (handler tests,
 * the fake agent) every one is `NotImplemented`.
 */
export const runtimeInstallHandlers = Effect.gen(function* () {
  const managed = yield* Effect.serviceOption(ManagedRuntimes);
  if (Option.isNone(managed)) {
    return {
      "agentRuntime.installState": () => missing("agentRuntime.installState"),
      "agentRuntime.watchInstall": () =>
        Stream.fail(new NotImplemented({ rpc: "agentRuntime.watchInstall" })),
      "agentRuntime.install": () => missing("agentRuntime.install"),
      "agentRuntime.cancel": () => missing("agentRuntime.cancel"),
      "agentRuntime.rollback": () => missing("agentRuntime.rollback"),
      "agentRuntime.useSource": () => missing("agentRuntime.useSource"),
    } satisfies Partial<Handlers>;
  }
  const runtimes = managed.value;
  const store = yield* ThreadStore;
  const threads = yield* ThreadRuntimes;
  const hosts = yield* AgentHosts;

  /** The live Codex threads among `ids`. */
  const codexThreads = (ids: ReadonlyArray<ThreadId>) =>
    Effect.forEach(ids, (id) =>
      store.getThread(id).pipe(
        Effect.map((thread) => (thread.model.agent === "codex" ? [thread.id] : [])),
        Effect.orElseSucceed(() => []),
      ),
    ).pipe(Effect.map((lists) => lists.flat()));

  yield* runtimes.connect({
    readSource: store.getSettings.pipe(
      Effect.map(codexRuntimeOf),
      Effect.orElseSucceed(() => "path" as const),
    ),
    writeSource: (source) =>
      store
        .updateSettings(
          (settings) => {
            const { codexRuntime: _previous, ...agents } = settings.agents;
            return {
              ...settings,
              agents: source === "path" ? agents : { ...agents, codexRuntime: source },
            };
          },
          [["agents", "codexRuntime"]],
        )
        .pipe(Effect.asVoid, Effect.orDie),
    busySessions: threads.working.pipe(
      Effect.flatMap(codexThreads),
      Effect.map((ids) => ids.length),
    ),
    switched: Effect.gen(function* () {
      const host = yield* hosts.get("codex").pipe(Effect.option);
      if (Option.isSome(host) && host.value.invalidateRuntime !== undefined) {
        yield* host.value.invalidateRuntime;
      }
      // As for a gateway key change: each live Codex session reopens on the new executable once
      // it is idle, so a turn under way finishes on the one it started with.
      for (const summary of yield* threads.snapshot) {
        if (summary.thread.model.agent === "codex") {
          yield* threads.reloadSession(summary.thread.id).pipe(Effect.ignore);
        }
      }
    }),
  });

  return {
    "agentRuntime.installState": ({ agent }) => runtimes.state(agent),
    "agentRuntime.watchInstall": ({ agent }) => runtimes.watch(agent),
    "agentRuntime.install": ({ agent, version }) => runtimes.install(agent, version),
    "agentRuntime.cancel": ({ agent }) => runtimes.cancel(agent),
    "agentRuntime.rollback": ({ agent }) => runtimes.rollback(agent),
    "agentRuntime.useSource": ({ agent, source }) => runtimes.useSource(agent, source),
  } satisfies Partial<Handlers>;
});
