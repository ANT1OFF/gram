import { createElement } from "react";

import {
  modelSpeeds,
  type AgentKind,
  type AgentModel,
  type PermissionMode,
  type SpeedMode,
  type SpeedState,
} from "@gram/contracts";

import { agentLabel } from "@/agents/agent-display";
import { cn } from "@/lib/utils";
import { modeWarning } from "@/thread/mode-warning";

import type { ChoiceOption, ChoiceSection } from "./choices";
import { DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION, MODE_ICONS, MODE_OPTIONS } from "./options";
import { SpeedGlyph } from "./picker-glyphs";
import type { PickerOption } from "./picker";
import { speedOptions, speedReport, speedUsage, speedValueWord } from "./speed-field";

// The four sections of the composer's choices, in its one order (model · effort · mode · speed),
// the same in a thread's composer and in `/new`. Each says its value in words in the chip's name,
// tooltip and popover; on the chip itself the model says its name beside the agent's mark, the mode
// draws its glyph, and Fast its bolt while on.

/** The model, its name on the chip beside the agent's mark, and in the chip's name and tooltip. */
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
    shortcut,
    value: value ?? DEFAULT_EFFORT,
    options,
    onChange,
  };
}

/** A mode's glyph, in the warning colour for one that never asks. */
const modeGlyph = (mode: PermissionMode, size: string) =>
  createElement(MODE_ICONS[mode], {
    "aria-hidden": true,
    className: cn(size, "shrink-0", modeWarning(mode) !== undefined && "text-warning"),
  });

/**
 * The permission mode: its glyph always on the chip, and each mode's beside its row in the list. One
 * that never asks (Bypass) is in the warning colour wherever its glyph is: what the agent may do
 * without asking matters.
 */
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
  const warning = modeWarning(value);
  return {
    id: "mode",
    label: "Mode",
    named,
    glyph: modeGlyph(value ?? "default", "size-icon-chip"),
    warning,
    shortcut,
    value,
    options: MODE_OPTIONS.map((option) => ({
      ...option,
      icon: modeGlyph(option.value, "size-icon-row"),
    })),
    onChange: (next) => onChange(next as PermissionMode),
  };
}

/**
 * The speed, for an agent with more than one: its bolt on the chip only when Fast, with what Fast
 * costs and what the CLI last reported under its list.
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
    glyph:
      value === "fast"
        ? createElement(SpeedGlyph, { speed: value, className: "size-icon-chip" })
        : undefined,
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
