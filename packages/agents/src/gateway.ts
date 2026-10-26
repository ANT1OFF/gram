import {
  AgentUnavailable,
  type AgentKind,
  type GatewayProfile,
  type ProfileId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

export interface GatewayCredentials {
  readonly profile: GatewayProfile;
  /** The user's gateway key. Only ever placed in a child process env, never logged. */
  readonly key: Redacted.Redacted<string>;
}

export interface GatewayKeyProviderShape {
  /** The profile and its key; fails when the profile is unknown or has no stored key. */
  readonly credentials: (
    profileId: ProfileId,
    agent: AgentKind,
  ) => Effect.Effect<GatewayCredentials, AgentUnavailable>;
}

/** Gateway profiles and their keys, provided by the server (Electron `safeStorage` on desktop). */
export class GatewayKeyProvider extends Context.Service<
  GatewayKeyProvider,
  GatewayKeyProviderShape
>()("@gram/agents/GatewayKeyProvider") {
  /** No profiles configured: every profile lookup is unavailable. */
  static readonly layerNone: Layer.Layer<GatewayKeyProvider> = Layer.succeed(GatewayKeyProvider)({
    credentials: (profileId, agent) =>
      Effect.fail(
        new AgentUnavailable({ agent, message: `Gateway profile ${profileId} isn't configured.` }),
      ),
  });
}
