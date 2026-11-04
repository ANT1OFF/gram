import {
  modelSpeeds,
  type AgentKind,
  type AgentModel,
  type SpeedMode,
  type SpeedState,
} from "@gram/contracts";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { Swap } from "@/motion";

import { PickerTrigger, usePickConfirm } from "./picker-trigger";
import { SpeedGlyph } from "./picker-glyphs";
import { GHOST_TRIGGER } from "./styles";

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
  /** Shows the value beside the glyph; without it the trigger's name and tooltip say it instead. */
  labelled?: boolean;
  /** `sm` to sit in a row of small controls; the ghost style is always small. */
  size?: "sm" | "default";
}) {
  const confirm = usePickConfirm(value);
  if (agent !== "claude" && agent !== "codex") return null;
  const fast = modelSpeeds(models, model).includes("fast");
  const items = speedOptions(models, model, value, state);
  const usage = speedUsage(agent);
  const report = speedReport(state);
  const shown = items.find((item) => item.value === (value ?? "default"))?.label ?? "CLI default";
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
          label="Speed"
          value={shown}
          labelled={labelled}
          icon={
            ghost && (
              <Swap swapKey={value ?? "default"}>
                <SpeedGlyph speed={value} />
              </Swap>
            )
          }
          confirm={ghost ? confirm.landed : undefined}
          title={`${usage} ${report}`}
          size={ghost ? "sm" : size}
          {...(ghost ? { className: GHOST_TRIGGER } : {})}
        />
        <SelectContent>
          {items.map((item) => (
            <SelectItem
              key={item.value}
              value={item.value}
              disabled={item.value === "fast" && !fast}
            >
              {item.label}
            </SelectItem>
          ))}
          <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">{usage}</p>
          <p role="status" className="max-w-72 px-2 py-1 text-xs text-muted-foreground">
            {report}
          </p>
        </SelectContent>
      </Select>
      {value === "fast" && !fast && (
        <p role="status" className="text-xs text-status-needs">
          Fast is not advertised for this model. Select Standard or retry model discovery.
        </p>
      )}
      {state && !ghost && (
        <p role="status" className="max-w-80 text-xs text-muted-foreground">
          {state.detail ??
            (state.speed === "unknown"
              ? "CLI speed not reported."
              : `Last CLI report: ${state.speed === "fast" ? "Fast" : "Standard"}.`)}
        </p>
      )}
    </div>
  );
}
