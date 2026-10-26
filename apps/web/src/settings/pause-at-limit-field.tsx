import type { OrchestratorCharter } from "@gram/contracts";

import { latestReadingAt, tightestLimit, useUsageLimits } from "@/stores/usage-limits";
import { meterText } from "@/usage/limit-format";

import { OptionGroup, SettingRow } from "./fields";

/** The thresholds offered; `off` leaves the charter without one. */
const PAUSE_AT_CHOICES = [
  { value: "off", label: "Off" },
  { value: "80", label: "80%" },
  { value: "90", label: "90%" },
  { value: "95", label: "95%" },
] as const;

type PauseChoice = (typeof PAUSE_AT_CHOICES)[number]["value"];

/** The charter with its threshold set to `choice`, or without one. */
const withPauseAt = (charter: OrchestratorCharter, choice: PauseChoice): OrchestratorCharter => {
  const { pauseAtLimitPct: _, ...rest } = charter;
  return choice === "off" ? rest : { ...rest, pauseAtLimitPct: Number(choice) };
};

/**
 * Per workspace: the share of a subscription limit at which the orchestrator stops starting
 * workers and asks once. One row, so Settings can move it as a whole.
 */
export function PauseAtLimitField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const limits = useUsageLimits((s) => s.limits);
  // As of the last reading: the row names the share, not how fresh it is.
  const tightest = tightestLimit(limits, latestReadingAt(limits));
  const pct = charter.pauseAtLimitPct;
  // A threshold set elsewhere that isn't one of the choices still shows as itself.
  const value = (pct === undefined ? "off" : String(pct)) as PauseChoice;
  const options = PAUSE_AT_CHOICES.some((choice) => choice.value === value)
    ? PAUSE_AT_CHOICES
    : [...PAUSE_AT_CHOICES, { value, label: `${pct}%` }];
  return (
    <div data-testid="pause-at-limit" data-value={value}>
      <SettingRow
        label="Pause new workers at"
        {...(tightest === undefined ? {} : { description: `${meterText(tightest)} now` })}
        keywords={["usage", "limit", "subscription", "pause", "workers"]}
      >
        <OptionGroup
          label="Pause new workers at"
          options={options}
          value={value}
          disabled={disabled}
          onChange={(choice) =>
            onChange(
              withPauseAt(charter, choice),
              choice === "off" ? "New workers never pause" : `New workers pause at ${choice}%`,
            )
          }
        />
      </SettingRow>
    </div>
  );
}
