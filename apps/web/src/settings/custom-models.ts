import type { AgentKind, CustomModel, ModelSuggestion } from "@gram/contracts";

/** The two supported harnesses a new custom model can be added for. */
export const CUSTOM_MODEL_AGENTS = ["claude", "codex"] as const satisfies AgentKind[];
export type CustomModelAgent = (typeof CUSTOM_MODEL_AGENTS)[number];

export const isCustomModelAgent = (agent: string): agent is CustomModelAgent =>
  (CUSTOM_MODEL_AGENTS as readonly string[]).includes(agent);

export interface CustomModelDraft {
  /** Local key for list rendering; not saved. */
  readonly key: string;
  readonly agent: CustomModelAgent;
  readonly id: string;
  readonly name: string;
  readonly effort: boolean;
}

export interface CustomModelsValidation {
  /** The first problem per row, or `undefined` for a valid row. */
  readonly rows: ReadonlyArray<string | undefined>;
  /** The models to save; absent while any row has a problem. */
  readonly models?: ReadonlyArray<CustomModel>;
}

/** What an agent lists itself: its ids, or `"unavailable"` once it has failed to say. */
export type ListedModels = ReadonlyArray<string> | "unavailable";

/**
 * The suggestions worth a button: for an agent a model can be added for, not already a row in the
 * editor, and not a model the agent lists itself. An agent missing from `listed` hasn't answered
 * yet, and its suggestions wait: reading a settings file is faster than asking an agent, so treating
 * "not yet" as "lists nothing" briefly offered `opus` as a custom model. Only an agent that failed to
 * answer (`"unavailable"`) has everything offered.
 */
export function pendingSuggestions(
  suggestions: ReadonlyArray<ModelSuggestion>,
  drafts: ReadonlyArray<CustomModelDraft>,
  listed: Partial<Record<CustomModelAgent, ListedModels>>,
): Array<ModelSuggestion & { readonly agent: CustomModelAgent }> {
  const seen = new Set(drafts.map((draft) => `${draft.agent}\n${draft.id.trim()}`));
  const out: Array<ModelSuggestion & { readonly agent: CustomModelAgent }> = [];
  for (const suggestion of suggestions) {
    const { agent, id } = suggestion;
    if (!isCustomModelAgent(agent)) continue;
    const known = listed[agent];
    if (known === undefined || (known !== "unavailable" && known.includes(id))) continue;
    const key = `${agent}\n${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...suggestion, agent });
  }
  return out;
}

/** Checks the editor's rows before `settings.agents.customModels` is saved. */
export function validateCustomModels(
  drafts: ReadonlyArray<CustomModelDraft>,
): CustomModelsValidation {
  const seen = new Set<string>();
  const models: CustomModel[] = [];
  const rows = drafts.map((draft) => {
    const id = draft.id.trim();
    if (id === "") return "Enter the model's id, as the agent expects it.";
    // An id goes to the agent as one argument; a space in it is a paste error, not a model.
    if (/\s/.test(id)) return "A model id can't contain spaces.";
    const key = `${draft.agent}\n${id}`;
    if (seen.has(key)) return "This model is already in the list.";
    seen.add(key);
    const name = draft.name.trim();
    models.push({
      agent: draft.agent,
      id,
      ...(name === "" ? {} : { name }),
      ...(draft.effort ? {} : { effort: false }),
    });
    return undefined;
  });
  return rows.some((row) => row !== undefined) ? { rows } : { rows, models };
}
