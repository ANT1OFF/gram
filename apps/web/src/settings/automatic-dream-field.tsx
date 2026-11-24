import {
  DEFAULT_MEMORY_UPDATE_EVERY_HOURS,
  DEFAULT_MEMORY_UPDATE_MIN_ITEMS,
  memoryUpdateRuleOf,
  type OrchestratorCharter,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useApi } from "@/api/context";
import { useNow } from "@/lib/use-now";
import { nextUpdateText } from "@/orchestration/memory-update-status";
import { Field, inputCls, Toggle } from "./fields";

function BoundedNumber({
  id,
  label,
  description,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const commit = () => {
    if (disabled || draft === undefined) return;
    const next = Number(draft);
    if (!/^\d+$/.test(draft) || !Number.isInteger(next) || next < min || next > max) {
      setError(`Choose a whole number from ${min} to ${max}.`);
      return;
    }
    setDraft(undefined);
    setError(undefined);
    if (next !== value) onCommit(next);
  };
  return (
    <>
      <Field label={label} description={description} htmlFor={id}>
        <input
          id={id}
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={1}
          className={inputCls}
          disabled={disabled}
          value={draft ?? String(value)}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      </Field>
      {error && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Whether a workspace's memory updates start by themselves, and the two conditions they wait for:
 * enough hours since the last began, and enough new items since the last one read.
 */
export function AutomaticDreamField({
  workspaceId,
  charter,
  disabled,
  onChange,
}: {
  workspaceId: WorkspaceId;
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const api = useApi();
  const rule = memoryUpdateRuleOf(charter);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(rule !== undefined, ref, 60_000);
  const status = useQuery({
    queryKey: ["automaticDreamStatus", workspaceId],
    queryFn: () => api.automaticDreamStatus(workspaceId),
    enabled: rule !== undefined,
  });
  const { automaticDreamThreshold: _items, memoryUpdateEveryHours: _hours, ...off } = charter;
  return (
    <div ref={ref} data-testid="automatic-dream-setting" className="flex flex-col gap-2">
      <Toggle
        label="Update memory automatically"
        checked={rule !== undefined}
        disabled={disabled}
        description="Run a memory update once enough time has passed and enough has happened since the last."
        learnMore={
          <p>
            Both must hold: the hours since the last update began, and the new items since the last
            one read. New items are worker reports that say what they learned, merges, answered
            questions and finished threads. Gram counts them from its own records, so waiting costs
            no model time. Each run lands as the workspace's memory updates do (Review or Auto, on
            its Memory page).
          </p>
        }
        keywords={["memory update", "dream", "automatic", "schedule", "new items", "memory"]}
        onChange={(on) =>
          onChange(
            on
              ? {
                  ...off,
                  memoryUpdateEveryHours: DEFAULT_MEMORY_UPDATE_EVERY_HOURS,
                  automaticDreamThreshold: DEFAULT_MEMORY_UPDATE_MIN_ITEMS,
                }
              : off,
          )
        }
      />
      {rule !== undefined && (
        <>
          <BoundedNumber
            id={`dream-hours-${workspaceId}`}
            label="Hours between updates"
            description="The least time from one memory update's start to the next."
            value={rule.everyHours}
            min={1}
            max={168}
            disabled={disabled}
            onCommit={(hours) => onChange({ ...charter, memoryUpdateEveryHours: hours })}
          />
          <BoundedNumber
            id={`dream-threshold-${workspaceId}`}
            label="New items per update"
            description="Lessons, merges, answers and finished threads to wait for."
            value={rule.minItems}
            min={1}
            max={1000}
            disabled={disabled}
            onCommit={(items) => onChange({ ...charter, automaticDreamThreshold: items })}
          />
          <p data-testid="automatic-dream-progress" className="text-meta text-muted-foreground">
            {status.data === undefined
              ? "Loading automatic memory update status…"
              : `${nextUpdateText(status.data, now) ?? ""} ${status.data.detail}`.trim()}
          </p>
          {status.isError && (
            <p role="alert" className="text-meta text-destructive">
              Automatic memory update status could not be loaded.
            </p>
          )}
        </>
      )}
    </div>
  );
}
