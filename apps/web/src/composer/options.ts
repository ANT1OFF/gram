import type { PermissionMode, ReasoningVariant } from "@gram/contracts";
import {
  FilePen,
  ListChecks,
  Lock,
  LockOpen,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { PickerOption } from "./picker";

/**
 * The modes the composer offers, each with what it lets the agent do without asking in one line,
 * read in the open list (the trigger stays a glyph). Codex runs the asking modes in its sandbox;
 * Bypass lifts it.
 */
export const MODE_OPTIONS: readonly PickerOption<PermissionMode>[] = [
  { value: "default", label: "Ask", description: "Asks before each file edit and command." },
  {
    value: "acceptEdits",
    label: "Accept edits",
    description: "Edits files without asking. Asks before running a command.",
  },
  {
    value: "plan",
    label: "Plan",
    description: "Reads and plans only. Changes nothing until you approve the plan.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "Edits and runs commands on its own. Risky steps are checked first.",
  },
  {
    value: "bypassPermissions",
    label: "Bypass",
    description: "Never asks. Edits files and runs any command, risky ones too.",
  },
];

/** Each mode's glyph on the mode picker; `dontAsk` is never offered there but can be a thread's. */
export const MODE_ICONS: Readonly<Record<PermissionMode, LucideIcon>> = {
  default: Lock,
  acceptEdits: FilePen,
  plan: ListChecks,
  auto: Sparkles,
  dontAsk: ShieldCheck,
  bypassPermissions: LockOpen,
};

/**
 * The reasoning efforts, lowest first. `short` is the value on the composer's trigger and in its
 * tooltip ("Effort: Extra high"); the open list reads the label, then what the level costs.
 */
export const EFFORT_OPTIONS: readonly PickerOption<ReasoningVariant>[] = [
  {
    value: "none",
    label: "No thinking",
    short: "No thinking",
    description: "Answers without reasoning first. The fastest.",
  },
  {
    value: "low",
    label: "Low effort",
    short: "Low",
    description: "Brief reasoning, for quick and simple steps.",
  },
  {
    value: "medium",
    label: "Medium effort",
    short: "Medium",
    description: "Balances speed and depth for everyday work.",
  },
  {
    value: "high",
    label: "High effort",
    short: "High",
    description: "Reasons longer before acting on harder problems.",
  },
  {
    value: "xhigh",
    label: "Extra high effort",
    short: "Extra high",
    description: "Reasons at length. Slower, and uses more of your plan.",
  },
  {
    value: "max",
    label: "Max effort",
    short: "Max",
    description: "Reasons as long as it needs. The slowest and costliest.",
  },
];

/** The effort pickers' "no explicit effort" value, which leaves the level to the model. */
export const DEFAULT_EFFORT = "default";

/** The effort pickers' first row: no explicit effort, so the model's own default applies. */
export const DEFAULT_EFFORT_OPTION: PickerOption<typeof DEFAULT_EFFORT> = {
  value: DEFAULT_EFFORT,
  label: "Default effort",
  short: "Default",
  description: "Whatever level the model uses on its own.",
};

/** Claude models offered before a session exists to report its own list. */
export const DEFAULT_MODEL_OPTIONS: readonly PickerOption<string>[] = [
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
];
