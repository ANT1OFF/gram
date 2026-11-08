import {
  modelSpeeds,
  type AgentKind,
  type AgentModel,
  type PermissionMode,
  type SpeedMode,
  type SpeedState,
} from "@gram/contracts";

import { agentLabel } from "@/agents/agent-display";
import { modeWarning } from "@/thread/mode-warning";

import type { ChoiceOption, ChoiceSection } from "./choices";
import { compactModelName, DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION, MODE_OPTIONS } from "./options";
import type { PickerOption } from "./picker";
import {
  speedCompactWord,
  speedOptions,
  speedReport,
  speedUsage,
  speedValueWord,
} from "./speed-field";

// The four sections of the composer's choices, in its one order (model · effort · mode · speed),
// the same in a thread's composer and in `/new`. Each says its value in words, and on the chip
// unless it is at its default: an effort left to the model and a speed that isn't Fast drop out,
// their name and tooltip still saying "Effort: Model default" and "Speed: Standard".

/** The model: its name on the chip, "Claude Opus", or in three to six letters, "Opus". */
export function modelSection({
  value,
  options,
  onChange,
  warning,
  shortcut,
  search,
  body,
}: {
  value: string | undefined;
  options: readonly PickerOption<string>[];
  onChange: (value: string) => void;
  warning?: string | undefined;
  shortcut?: ChoiceSection["shortcut"];
  search?: ChoiceSection["search"];
  body?: ChoiceSection["body"];
}): ChoiceSection {
  const chosen = options.find((option) => option.value === value);
  const named = chosen?.label ?? (value || "Model");
  return {
    id: "model",
    label: "Model",
    named,
    chip: { full: named, compact: chosen?.compact ?? compactModelName(named) },
    warning,
    shortcut,
    value,
    options,
    onChange,
    search: search ?? {},
    body,
  };
}

/** The effort, when the model has levels; else greyed, saying it has none. */
export function effortSection({
  efforts,
  value,
  onChange,
  shortcut,
}: {
  /** The model's levels, without the default; none greys the section. */
  efforts: readonly PickerOption<string>[];
  /** The chosen level; absent leaves it to the model. */
  value: string | undefined;
  onChange: (value: string) => void;
  shortcut?: ChoiceSection["shortcut"];
}): ChoiceSection {
  if (efforts.length === 0)
    return {
      id: "effort",
      label: "Effort",
      named: "None",
      unavailable: "This model has no effort levels",
      shortcut,
    };
  const options = [DEFAULT_EFFORT_OPTION, ...efforts];
  const chosen = options.find((option) => option.value === (value ?? DEFAULT_EFFORT));
  const named = chosen?.short ?? chosen?.label ?? DEFAULT_EFFORT_OPTION.short;
  return {
    id: "effort",
    label: "Effort",
    named,
    chip:
      value === undefined || value === DEFAULT_EFFORT
        ? undefined
        : { full: named, compact: chosen?.compact ?? named },
    shortcut,
    value: value ?? DEFAULT_EFFORT,
    options,
    onChange,
  };
}

/** The permission mode, always on the chip: what the agent may do without asking matters. */
export function modeSection({
  value,
  onChange,
  shortcut,
}: {
  value: PermissionMode | undefined;
  onChange: (value: PermissionMode) => void;
  shortcut?: ChoiceSection["shortcut"];
}): ChoiceSection {
  const chosen = MODE_OPTIONS.find((option) => option.value === value);
  const named = chosen?.label ?? value ?? "Ask";
  return {
    id: "mode",
    label: "Mode",
    named,
    chip: value === undefined ? undefined : { full: named, compact: chosen?.compact ?? named },
    warning: modeWarning(value),
    shortcut,
    value,
    options: MODE_OPTIONS,
    onChange: (next) => onChange(next as PermissionMode),
  };
}

/**
 * The speed, for an agent with more than one: on the chip only when Fast, with what Fast costs and
 * what the CLI last reported under its list.
 */
export function speedSection({
  agent,
  models,
  model,
  value,
  state,
  onChange,
}: {
  agent: AgentKind;
  models: readonly AgentModel[] | undefined;
  model: string;
  value: SpeedMode | undefined;
  state?: SpeedState | undefined;
  onChange: (value: SpeedMode) => void;
}): ChoiceSection {
  if (agent !== "claude" && agent !== "codex")
    return {
      id: "speed",
      label: "Speed",
      named: "One speed",
      unavailable: `${agentLabel(agent)} has one speed`,
    };
  const fast = modelSpeeds(models, model).includes("fast");
  const options: ChoiceOption[] = speedOptions(models, model, value, state).map((option) =>
    "disabled" in option && option.disabled
      ? { ...option, description: "Not offered for this model." }
      : option,
  );
  const named = speedValueWord(value, state);
  return {
    id: "speed",
    label: "Speed",
    named,
    chip: value === "fast" ? { full: named, compact: speedCompactWord(value) } : undefined,
    value: value ?? "default",
    options,
    onChange: (next) => {
      if (next === "standard" || (next === "fast" && fast)) onChange(next);
    },
    notes: [
      ...(value === "fast" && !fast
        ? ["Fast is not advertised for this model. Select Standard or retry model discovery."]
        : []),
      speedUsage(agent),
      speedReport(state),
    ],
  };
}
