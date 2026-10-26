import { describe, expect, it } from "@effect/vitest";
import { GatewayKeyProvider } from "@gram/agents";
import { AgentUnavailable, type ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { GatewayCredentials } from "./credentials.ts";

const layer = GatewayCredentials.layerProvider.pipe(Layer.provideMerge(GatewayCredentials.layer));

describe("GatewayCredentials", () => {
  it.effect("is unavailable until the gateway installs its lookup, then delegates to it", () =>
    Effect.gen(function* () {
      const provider = yield* GatewayKeyProvider;
      const early = yield* Effect.flip(provider.credentials("litellm" as ProfileId, "codex"));
      expect(early).toBeInstanceOf(AgentUnavailable);
      expect(early.message).toBe("Gateway profiles aren't loaded yet.");

      const credentials = yield* GatewayCredentials;
      yield* credentials.install((profileId) =>
        Effect.succeed({
          profile: {
            id: profileId,
            name: "LiteLLM",
            baseURL: "https://llm.example/v1",
            keyRef: "profile:litellm",
            models: [],
          },
          key: Redacted.make("sk-test"),
        }),
      );
      const resolved = yield* provider.credentials("litellm" as ProfileId, "codex");
      expect(resolved.profile.name).toBe("LiteLLM");
      expect(Redacted.value(resolved.key)).toBe("sk-test");
    }).pipe(Effect.provide(layer)),
  );
});
