import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SETTINGS, type ModelRef } from "@gram/contracts";
import type { AgentHost } from "@gram/agents";
import * as Effect from "effect/Effect";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { defaultDreamModel } from "./automatic-dream.ts";

/** A host for `kind` that lists `models`, or fails as a CLI that isn't installed would. */
const listingHost = (kind: "claude" | "codex", models: ReadonlyArray<{ id: string }> | undefined) =>
  ({
    kind,
    listModels: () =>
      models === undefined
        ? Effect.fail(new Error(`synthetic: ${kind} not installed`))
        : Effect.succeed(models),
  }) as unknown as AgentHost;
const savedDefault = (model: ModelRef) => ({
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, defaultModel: model },
});

describe("defaultDreamModel", () => {
  const unsaved = DEFAULT_SETTINGS;

  it.effect("with nothing saved, dreams on the agent that is installed, Claude Code first", () =>
    Effect.gen(function* () {
      const codexOnly = AgentHosts.fromHosts([
        listingHost("claude", undefined),
        listingHost("codex", [{ id: "gpt" }]),
      ]);
      expect(yield* defaultDreamModel(unsaved, codexOnly)).toEqual({
        agent: "codex",
        model: "default",
      });
      const both = AgentHosts.fromHosts([
        listingHost("claude", [{ id: "opus" }]),
        listingHost("codex", []),
      ]);
      expect(yield* defaultDreamModel(unsaved, both)).toEqual({
        agent: "claude",
        model: "default",
      });
      const neither = AgentHosts.fromHosts([]);
      expect(yield* defaultDreamModel(unsaved, neither)).toEqual({
        agent: "claude",
        model: "default",
      });
    }),
  );

  it.effect("keeps a saved default even when its agent lists nothing now", () =>
    Effect.gen(function* () {
      const model: ModelRef = { agent: "claude", model: "opus" };
      const codexOnly = AgentHosts.fromHosts([listingHost("codex", [{ id: "gpt" }])]);
      expect(yield* defaultDreamModel(savedDefault(model), codexOnly)).toEqual(model);
    }),
  );
});
