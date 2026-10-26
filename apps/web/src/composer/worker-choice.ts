import type { AgentKind, ModelRef, TaskWorkerChoice } from "@gram/contracts";

/** One roster entry's identity, as New task remembers a pick: the entry, not just its model id. */
export const workerChoiceKey = (model: ModelRef): string =>
  JSON.stringify([
    model.agent,
    model.model,
    model.profileId ?? "",
    model.variant ?? "",
    model.speed ?? "standard",
  ]);

/** A choice's name in the picker: the model, and its effort when the entry sets one. */
export const workerChoiceLabel = (model: ModelRef): string =>
  model.variant === undefined ? model.model : `${model.model} · ${model.variant}`;

/**
 * The choice a draft shows: the one picked, or remembered for the target, while it can still run
 * here; else the roster's default, which may be unavailable and then has to be picked over.
 */
export const shownWorkerChoice = (
  choices: readonly TaskWorkerChoice[],
  picked: string | undefined,
): TaskWorkerChoice | undefined => {
  const named = choices.find((choice) => workerChoiceKey(choice.model) === picked);
  if (named !== undefined && named.unavailable === undefined) return named;
  return choices.find((choice) => choice.default === true) ?? choices[0];
};

/** The harnesses on the roster, in its order. */
export const workerAgents = (choices: readonly TaskWorkerChoice[]): AgentKind[] => [
  ...new Set(choices.map((choice) => choice.model.agent)),
];

/** What switching to `agent` picks: its default if that can run, else its first that can. */
export const firstWorkerChoiceOf = (
  choices: readonly TaskWorkerChoice[],
  agent: AgentKind,
): TaskWorkerChoice | undefined => {
  const usable = choices.filter(
    (choice) => choice.model.agent === agent && choice.unavailable === undefined,
  );
  return usable.find((choice) => choice.default === true) ?? usable[0];
};
