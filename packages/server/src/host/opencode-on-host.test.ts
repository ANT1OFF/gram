import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { AgentUnavailable, HostStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hostStatusOf } from "./claude-sign-in.ts";
import { openCodeStatusOf } from "./opencode-on-host.ts";

const MODELS = [
  {
    id: "openai/gpt-synthetic",
    displayName: "GPT Synthetic",
    description: "Not carried",
    supportsEffort: false,
  },
];

/** A machine's OpenCode that lists `models`, or fails to. */
const opencode = (models: "ok" | "fail"): Effect.Effect<AgentHost, AgentUnavailable> =>
  Effect.succeed({
    kind: "opencode",
    capabilities: {} as AgentHost["capabilities"],
    open: () => Effect.die("not opened"),
    listModels: () =>
      models === "ok"
        ? Effect.succeed(MODELS)
        : Effect.fail(new AgentUnavailable({ agent: "opencode", message: "no providers" })),
  });

const installed = () => Promise.resolve({ code: 0, stdout: "2.3.0\n" });
const absent = () => Promise.resolve({ code: 1, stdout: "" });

describe("a joined machine's OpenCode status", () => {
  it.effect("an installed OpenCode says what it lists, and nothing of the description", () =>
    Effect.gen(function* () {
      expect(yield* openCodeStatusOf(opencode("ok"), installed)).toEqual({
        found: true,
        version: "2.3.0",
        models: [
          { id: "openai/gpt-synthetic", displayName: "GPT Synthetic", supportsEffort: false },
        ],
      });
    }),
  );

  it.effect("one that can't list leaves its models out, and one that answers is found", () =>
    Effect.gen(function* () {
      expect(yield* openCodeStatusOf(opencode("fail"), installed)).toEqual({
        found: true,
        version: "2.3.0",
      });
      expect((yield* openCodeStatusOf(opencode("ok"), absent)).found).toBe(true);
      expect(yield* openCodeStatusOf(opencode("fail"), absent)).toEqual({ found: false });
    }),
  );

  it.effect("crosses in the host's status, which decodes with it", () =>
    Effect.gen(function* () {
      const status = yield* hostStatusOf(
        Effect.succeed("unknown"),
        absent,
        Effect.succeed(undefined),
        Effect.succeed(undefined),
        openCodeStatusOf(opencode("ok"), installed),
      );
      expect(status.opencode?.models?.[0]?.id).toBe("openai/gpt-synthetic");
      const decoded = Schema.decodeUnknownSync(HostStatus)(Schema.encodeSync(HostStatus)(status));
      expect(decoded.opencode).toEqual(status.opencode);
    }),
  );
});
