import { GatewayKeyProvider, type GatewayKeyProviderShape } from "@gram/agents";
import { AgentUnavailable } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type Lookup = GatewayKeyProviderShape["credentials"];

export interface GatewayCredentialsShape {
  /** Installs the profile + key lookup, once the store and key vault exist. */
  readonly install: (lookup: Lookup) => Effect.Effect<void>;
  readonly provider: GatewayKeyProviderShape;
}

/**
 * Gateway credentials for agent adapters. The agent hosts are built before the RPC layer that owns
 * the profile store and key vault, so the lookup is installed late by `gatewayHandlers`.
 */
export class GatewayCredentials extends Context.Service<
  GatewayCredentials,
  GatewayCredentialsShape
>()("@gram/server/GatewayCredentials") {
  static readonly layer: Layer.Layer<GatewayCredentials> = Layer.sync(GatewayCredentials)(() => {
    let lookup: Lookup | undefined;
    return {
      install: (next) =>
        Effect.sync(() => {
          lookup = next;
        }),
      provider: {
        credentials: (profileId, agent) =>
          lookup === undefined
            ? Effect.fail(
                new AgentUnavailable({ agent, message: "Gateway profiles aren't loaded yet." }),
              )
            : lookup(profileId, agent),
      },
    };
  });

  /** The installed lookup as the adapters' `GatewayKeyProvider`. */
  static readonly layerProvider: Layer.Layer<GatewayKeyProvider, never, GatewayCredentials> =
    Layer.effect(GatewayKeyProvider)(
      Effect.gen(function* () {
        return (yield* GatewayCredentials).provider;
      }),
    );
}
