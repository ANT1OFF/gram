import { AgentUnavailable, localSubscriptionDefault, type ModelRef } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { AgentHosts } from "./agent-hosts.ts";

/** Called only when no explicit model was supplied or saved. Discovery never selects a gateway. */
export const discoverDefaultModel = (
  hosts: AgentHosts["Service"],
): Effect.Effect<ModelRef, AgentUnavailable> =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      ["claude", "codex"] as const,
      (agent) =>
        hosts.get(agent).pipe(
          Effect.flatMap((host) => host.listModels()),
          Effect.result,
        ),
      { concurrency: 2 },
    );
    const model = localSubscriptionDefault(
      Result.isSuccess(results[0]!) ? results[0]!.success : undefined,
      Result.isSuccess(results[1]!) ? results[1]!.success : undefined,
    );
    if (model !== undefined) return model;
    return yield* new AgentUnavailable({
      agent: "claude",
      message: `No local agent offered a default model. ${results
        .map(
          (result, i) =>
            `${i === 0 ? "Claude Code" : "Codex"}: ${Result.isFailure(result) ? result.failure.message : "no models listed"}`,
        )
        .join(". ")}. Select an agent and check its installation and login.`,
    });
  });
