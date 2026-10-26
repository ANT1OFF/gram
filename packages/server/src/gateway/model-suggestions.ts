import type { ModelSuggestion, Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A model id as an agent would take it: something, with no whitespace in it. */
const isModelId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !/\s/.test(value);

/**
 * The model ids Claude Code's `settings.json` mentions: the default `model`, and every key of
 * `modelSettings`, where it keeps per-model preferences for models the user has run. Nothing else in
 * the file is read, and anything that isn't shaped as expected yields no suggestions.
 */
export const claudeSettingsModels = (settings: unknown): ReadonlyArray<string> => {
  if (!isRecord(settings)) return [];
  const perModel = isRecord(settings["modelSettings"])
    ? Object.keys(settings["modelSettings"])
    : [];
  return [...new Set([settings["model"], ...perModel].filter(isModelId))];
};

/**
 * The models Claude threads run, which is where one reached with `/model` ends up. A thread on a
 * gateway profile is left out: its model belongs to that profile's catalogue, not to Claude's.
 */
export const threadModelSuggestions = (
  threads: ReadonlyArray<Pick<Thread, "model">>,
): ReadonlyArray<ModelSuggestion> => {
  const ids = threads.flatMap(({ model }) =>
    model.agent === "claude" && model.profileId === undefined && isModelId(model.model)
      ? [model.model]
      : [],
  );
  return [...new Set(ids)].map((id) => ({ agent: "claude", id, source: "a thread's model" }));
};

/** `$CLAUDE_CONFIG_DIR`, else `~/.claude`, as the CLI resolves it. */
const claudeConfigDir = (home: string, env: NodeJS.ProcessEnv): string => {
  const configured = env["CLAUDE_CONFIG_DIR"];
  return configured === undefined || configured === "" ? join(home, ".claude") : configured;
};

/**
 * Custom models worth offering, from the user's own agent config. Only Claude Code's today. A
 * missing or unreadable file is the normal case for someone who never ran the CLI, so it is an empty
 * answer and never an error.
 */
export const modelSuggestions = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ReadonlyArray<ModelSuggestion>> => {
  const file = join(claudeConfigDir(home, env), "settings.json");
  return Effect.tryPromise(() => readFile(file, "utf8")).pipe(
    Effect.map((text): ReadonlyArray<ModelSuggestion> =>
      claudeSettingsModels(JSON.parse(text) as unknown).map((id) => ({
        agent: "claude",
        id,
        source: "Claude Code settings",
      })),
    ),
    // `JSON.parse` throwing inside `map` is a defect, not a failure, so catch both.
    Effect.catchCause(() => Effect.succeed([])),
  );
};
