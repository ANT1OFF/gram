import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ManagedRuntimes } from "../agent-runtime/service.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { makeAgentSupport } from "./service.ts";

export const agentSupportHandlers = Effect.gen(function* () {
  const runtimes = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
  const managed = Option.getOrUndefined(yield* Effect.serviceOption(ManagedRuntimes));
  const registry = Option.getOrUndefined(yield* Effect.serviceOption(AppToolRegistry));
  const service = makeAgentSupport({
    hosts: yield* AgentHosts,
    store: yield* ThreadStore,
    checks: yield* LaunchChecksCache,
    ...(managed === undefined ? {} : { managed }),
    ...(registry === undefined ? {} : { registry }),
    ...(runtimes === undefined
      ? {}
      : {
          identity: (model, threadId) =>
            runtimes
              .summaryOf(threadId)
              .pipe(
                Effect.map((row) =>
                  row !== undefined &&
                  row.thread.model.agent === model.agent &&
                  row.thread.model.profileId === model.profileId &&
                  row.thread.model.model === model.model
                    ? row.identity
                    : undefined,
                ),
              ),
        }),
  });
  return { "agents.support": (input) => service.read(input) } satisfies Partial<Handlers>;
});
