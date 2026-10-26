import type { AgentHost } from "@gram/agents";
import { AgentUnavailable, type AgentKind } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Resolves the host for an agent kind. */
export class AgentHosts extends Context.Service<
  AgentHosts,
  { get(kind: AgentKind): Effect.Effect<AgentHost, AgentUnavailable> }
>()("@gram/server/AgentHosts") {
  /** The given hosts; any other kind is unavailable. */
  static readonly fromHosts = (hosts: ReadonlyArray<AgentHost>): AgentHosts["Service"] =>
    AgentHosts.of({
      get: (agent) => {
        const host = hosts.find((h) => h.kind === agent);
        return host === undefined
          ? Effect.fail(
              new AgentUnavailable({ agent, message: `no ${agent} adapter in this build` }),
            )
          : Effect.succeed(host);
      },
    });

  static readonly layerNone: Layer.Layer<AgentHosts> = Layer.succeed(
    AgentHosts,
    AgentHosts.fromHosts([]),
  );
}
