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

export const MODE_OPTIONS: readonly PickerOption<PermissionMode>[] = [
  { value: "default", label: "Ask" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass" },
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

export const EFFORT_OPTIONS: readonly PickerOption<ReasoningVariant>[] = [
  { value: "none", label: "No thinking" },
  { value: "low", label: "Low effort" },
  { value: "medium", label: "Medium effort" },
  { value: "high", label: "High effort" },
  { value: "xhigh", label: "Extra high effort" },
  { value: "max", label: "Max effort" },
];

/** Claude models offered before a session exists to report its own list. */
export const DEFAULT_MODEL_OPTIONS: readonly PickerOption<string>[] = [
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
];
