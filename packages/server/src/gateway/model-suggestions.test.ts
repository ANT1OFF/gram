import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileId } from "@gram/contracts";
import {
  claudeSettingsModels,
  modelSuggestions,
  threadModelSuggestions,
} from "./model-suggestions.ts";

const homeWith = (settings: string | undefined, dir = ".claude") =>
  Effect.gen(function* () {
    const home = mkdtempSync(join(tmpdir(), "gram-suggest-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(home, { recursive: true, force: true })),
    );
    if (settings !== undefined) {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, dir, "settings.json"), settings);
    }
    return home;
  });

describe("claudeSettingsModels", () => {
  it("takes the default model and the per-model settings keys, once each", () => {
    expect(
      claudeSettingsModels({
        model: "opus[1m]",
        modelSettings: { "claude-preview-eap": { effortLevel: "high" }, "opus[1m]": {} },
        env: { ANTHROPIC_API_KEY: "never read" },
      }),
    ).toEqual(["opus[1m]", "claude-preview-eap"]);
  });

  it("yields nothing for shapes it doesn't expect", () => {
    for (const settings of [
      null,
      [],
      "x",
      {},
      { model: 5 },
      { model: "two words" },
      { modelSettings: [] },
    ])
      expect(claudeSettingsModels(settings)).toEqual([]);
  });
});

describe("threadModelSuggestions", () => {
  it("offers each model a Claude thread runs once, and none from a gateway profile", () => {
    expect(
      threadModelSuggestions([
        { model: { agent: "claude", model: "claude-preview[1m]" } },
        { model: { agent: "claude", model: "claude-preview[1m]", variant: "high" } },
        { model: { agent: "claude", model: "gpt-5", profileId: ProfileId.make("p1") } },
        { model: { agent: "codex", model: "gpt-5" } },
      ]),
    ).toEqual([{ agent: "claude", id: "claude-preview[1m]", source: "a thread's model" }]);
  });
});

describe("modelSuggestions", () => {
  it.effect("reads Claude Code's settings under the home folder", () =>
    Effect.gen(function* () {
      const home = yield* homeWith(JSON.stringify({ model: "opus[1m]" }));
      expect(yield* modelSuggestions(home, {})).toEqual([
        { agent: "claude", id: "opus[1m]", source: "Claude Code settings" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("follows CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const home = yield* homeWith(JSON.stringify({ model: "sonnet" }), "elsewhere");
      const env = { CLAUDE_CONFIG_DIR: join(home, "elsewhere") };
      expect((yield* modelSuggestions(home, env)).map((s) => s.id)).toEqual(["sonnet"]);
    }).pipe(Effect.scoped),
  );

  it.effect("is empty, not an error, without the file or with a broken one", () =>
    Effect.gen(function* () {
      expect(yield* modelSuggestions(yield* homeWith(undefined), {})).toEqual([]);
      expect(yield* modelSuggestions(yield* homeWith("{ not json"), {})).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
