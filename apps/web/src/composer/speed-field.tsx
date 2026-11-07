import {
  modelSpeeds,
  type AgentKind,
  type AgentModel,
  type SpeedMode,
  type SpeedState,
} from "@gram/contracts";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { useRef } from "react";

import { Swap } from "@/motion";

import { aboveComposer } from "./above-composer";
import { PickerTrigger, usePickConfirm } from "./picker-trigger";
import { SpeedGlyph } from "./picker-glyphs";
import { GHOST_TRIGGER } from "./styles";
import type { LabelSize } from "./toolbar-layout";

export const speedOptions = (
  models: readonly AgentModel[] | undefined,
  model: string,
  value: SpeedMode | undefined,
  state?: SpeedState,
) => {
  const fast = modelSpeeds(models, model).includes("fast");
  return [
    ...(value === undefined ? [{ value: "default", label: "CLI default" }] : []),
    { value: "standard", label: "Standard" },
    ...(fast || value === "fast"
      ? [
          {
            value: "fast",
            label: state && state.speed !== "fast" ? "Fast (requested)" : "Fast",
            disabled: !fast,
          },
        ]
      : []),
  ];
};

/**
 * A speed in a word or two for the toolbar: "CLI default" (the CLI decides, so it says whose
 * default), "Standard", "Fast", or "Fast (requested)" while the CLI hasn't confirmed it.
 */
export const speedValueWord = (value: SpeedMode | undefined, state?: SpeedState): string =>
  value === undefined
    ? "CLI default"
    : value === "standard"
      ? "Standard"
      : state && state.speed !== "fast"
        ? "Fast (requested)"
        : "Fast";

/**
 * The same, short of room: "Speed: Std", "Speed: Fast", "Speed: Default", and tighter the word
 * alone beside the bolt (`ValueWords`). The speed always shows, never "Speed" on its own; whose
 * default it is, and a Fast still requested, are on its hover and in its name.
 */
export const speedCompactWord = (value: SpeedMode | undefined): string =>
  value === "fast" ? "Fast" : value === "standard" ? "Std" : "Default";

export const speedReport = (state?: SpeedState) =>
  state?.detail ??
  (state?.speed === "unknown"
    ? "CLI speed not reported."
    : state
      ? `Last CLI report: ${state.speed === "fast" ? "Fast" : "Standard"}. Provider fallback can still apply.`
      : "Speed preference applies to the next turn.");

/** Provider-specific usage, kept next to the explicit choice rather than hidden in Settings. */
export const speedUsage = (agent: AgentKind) =>
  agent === "claude"
    ? "Claude Fast uses separately billed usage credits, outside Pro/Max included usage. Your CLI checks availability."
    : "Codex Fast uses more subscription allowance or credits. API-key sessions use API pricing. Your CLI checks availability.";

export function SpeedField({
  agent,
  model,
  models,
  value,
  onChange,
  state,
  ghost = false,
  disabled = false,
  labelled = true,
  size = "default",
}: {
  agent: AgentKind;
  model: string;
  models: readonly AgentModel[] | undefined;
  value: SpeedMode | undefined;
  onChange: (speed: SpeedMode) => void;
  state?: SpeedState | undefined;
  ghost?: boolean;
  disabled?: boolean;
  /**
   * On a toolbar (`ghost`), shows the value beside the bolt; either way its name and tooltip say it.
   * Outside one the trigger is a form's field, value in full.
   */
  labelled?: boolean | LabelSize;
  /** `sm` to sit in a row of small controls; the ghost style is always small. */
  size?: "sm" | "default";
}) {
  const confirm = usePickConfirm(value);
  const trigger = useRef<HTMLButtonElement>(null);
  if (agent !== "claude" && agent !== "codex") return null;
  const fast = modelSpeeds(models, model).includes("fast");
  const items = speedOptions(models, model, value, state);
  const usage = speedUsage(agent);
  const report = speedReport(state);
  const shown = items.find((item) => item.value === (value ?? "default"))?.label ?? "CLI default";
  // On a toolbar a short value after its dimension, "Speed: Standard", as effort and mode say theirs.
  const toolbarValue = ghost ? speedValueWord(value, state) : shown;
  return (
    <div className="flex flex-col gap-1" data-testid="speed-field">
      <Select
        value={value ?? "default"}
        items={items}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== "standard" && !(next === "fast" && fast)) return;
          confirm.pick(next);
          onChange(next);
        }}
      >
        <PickerTrigger
          ref={trigger}
          label="Speed"
          value={toolbarValue}
          // "Speed: Default" on the chip; its name and tooltip say whose, "Speed: CLI default".
          words={ghost && value === undefined ? "Default" : undefined}
          compact={ghost ? speedCompactWord(value) : undefined}
          labelled={labelled}
          field={!ghost}
          icon={
            ghost && (
              <Swap swapKey={value ?? "default"}>
                <SpeedGlyph speed={value} className="size-icon-bar" />
              </Swap>
            )
          }
          confirm={ghost ? confirm.landed : undefined}
          title={`${usage} ${report}`}
          size={ghost ? "sm" : size}
          {...(ghost ? { className: GHOST_TRIGGER } : {})}
        />
        {/* On a toolbar, never over the draft: flipped up, it clears the whole composer. */}
        <SelectContent {...(ghost ? { anchor: () => aboveComposer(trigger.current) } : {})}>
          {items.map((item) => (
            <SelectItem
              key={item.value}
              value={item.value}
              disabled={item.value === "fast" && !fast}
            >
              {item.label}
            </SelectItem>
          ))}
          <p className="max-w-72 px-2 py-1 text-meta text-muted-foreground">{usage}</p>
          <p role="status" className="max-w-72 px-2 py-1 text-meta text-muted-foreground">
            {report}
          </p>
        </SelectContent>
      </Select>
      {value === "fast" && !fast && (
        <p role="status" className="text-meta text-muted-foreground">
          Fast is not advertised for this model. Select Standard or retry model discovery.
        </p>
      )}
      {state && !ghost && (
        <p role="status" className="max-w-80 text-meta text-muted-foreground">
          {state.detail ??
            (state.speed === "unknown"
              ? "CLI speed not reported."
              : `Last CLI report: ${state.speed === "fast" ? "Fast" : "Standard"}.`)}
        </p>
      )}
    </div>
  );
}
